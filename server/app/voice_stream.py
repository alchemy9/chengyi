"""Overlap text generation and short-sentence speech without waiting for a full reply."""
import asyncio
import base64
from contextlib import suppress
from time import monotonic

import httpx

from app.speech import MESSAGES, SpeechUnavailable, synthesize, stream_pcm
from app.text_stream import SentenceBuffer


async def stream_voice(source, settings, transport=None, audio_format="mp3"):
    output = asyncio.Queue(maxsize=32)
    # The 4000-character budget bounds this queue; slow speech must not stall text.
    sentences = asyncio.Queue()
    started = monotonic()
    epoch = 0
    worker = None
    buffer = SentenceBuffer(first_length=28)
    spoken_chars = 0
    limit_reported = False
    failed = False
    metrics = {"first_text_ms": None, "text_done_ms": None, "first_audio_byte_ms": None,
               "first_audio_ready_ms": None, "first_speech_request_ms": None,
               "audio_format": audio_format, "segments": 0, "resets": 0, "speech_error": None}

    def elapsed():
        return int((monotonic() - started) * 1000)

    async def speak_sentences(queue, current_epoch, client=None):
        nonlocal failed
        sequence = 0
        while True:
            sentence = await queue.get()
            if sentence is None:
                return
            if failed:
                continue
            sequence += 1
            if metrics["first_speech_request_ms"] is None:
                metrics["first_speech_request_ms"] = elapsed()
            await output.put({"event": "speech_pending", "data": {
                "epoch": current_epoch, "sequence": sequence, "elapsed_ms": elapsed()}})

            async def first_byte(ms):
                if metrics["first_audio_byte_ms"] is None:
                    metrics["first_audio_byte_ms"] = elapsed()

            try:
                if audio_format == "pcm":
                    await output.put({"event": "audio_start", "data": {
                        "epoch": current_epoch, "sequence": sequence, "text": sentence,
                        "sample_rate": 24000, "channels": 1, "encoding": "pcm_s16le"}})
                    async for part in stream_pcm(settings, sentence, client):
                        if metrics["first_audio_byte_ms"] is None:
                            metrics["first_audio_byte_ms"] = elapsed()
                            metrics["first_audio_ready_ms"] = elapsed()
                        await output.put({"event": "audio_chunk", "data": {
                            "epoch": current_epoch, "sequence": sequence, "sample_rate": 24000,
                            "channels": 1, "encoding": "pcm_s16le", "elapsed_ms": elapsed(),
                            "audio_base64": base64.b64encode(part).decode("ascii")}})
                    await output.put({"event": "audio_end", "data": {
                        "epoch": current_epoch, "sequence": sequence, "elapsed_ms": elapsed()}})
                else:
                    audio = await synthesize(settings, sentence, transport, on_first_byte=first_byte)
                    if metrics["first_audio_ready_ms"] is None:
                        metrics["first_audio_ready_ms"] = elapsed()
                    await output.put({"event": "audio", "data": {
                        **audio.as_dict(), "epoch": current_epoch, "sequence": sequence,
                        "text": sentence, "elapsed_ms": elapsed()}})
                metrics["segments"] += 1
            except SpeechUnavailable as exc:
                failed = True
                metrics["speech_error"] = exc.code
                await output.put({"event": "speech_error", "data": {
                    "code": exc.code, "message": exc.message, "epoch": current_epoch}})

    async def speak(queue, current_epoch):
        if audio_format == "pcm":
            # Keep the connection for following sentences instead of repeating TLS setup.
            async with httpx.AsyncClient(timeout=settings.speech_timeout_seconds,
                    transport=transport, follow_redirects=False) as client:
                await speak_sentences(queue, current_epoch, client)
        else:
            await speak_sentences(queue, current_epoch)

    async def submit(texts):
        nonlocal spoken_chars, limit_reported
        for sentence in texts:
            if failed or limit_reported:
                return
            if spoken_chars + len(sentence) > 4000:
                if not limit_reported:
                    limit_reported = True
                    await output.put({"event": "speech_warning", "data": {
                        "code": "speech_limit", "message": MESSAGES["speech_limit"]}})
                return
            spoken_chars += len(sentence)
            await sentences.put(sentence)

    async def cancel_worker():
        if worker:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)

    async def run():
        nonlocal worker, sentences, buffer, epoch, spoken_chars, failed
        worker = asyncio.create_task(speak(sentences, epoch))
        result_received = False
        cancelled = False
        try:
            async with asyncio.timeout(180):
                async for event in source:
                    kind = event["event"]
                    if kind == "reset":
                        await cancel_worker()
                        epoch += 1
                        metrics["resets"] += 1
                        sentences = asyncio.Queue()
                        buffer, spoken_chars = SentenceBuffer(first_length=28), 0
                        worker = asyncio.create_task(speak(sentences, epoch))
                    await output.put(event)
                    if kind == "delta":
                        if metrics["first_text_ms"] is None:
                            metrics["first_text_ms"] = elapsed()
                        await submit(buffer.feed(event["data"]["text"]))
                    elif kind == "result":
                        result_received = True
                        metrics["text_done_ms"] = elapsed()
                    elif kind == "error":
                        await cancel_worker()
                        return
                await submit(buffer.feed("", final=True))
                await sentences.put(None)
                await worker
        except TimeoutError:
            metrics["speech_error"] = "voice_timeout"
            await output.put({"event": "speech_error", "data": {
                "code": "voice_timeout", "message": "本轮语音处理超时，请缩短讲解或稍后重试"}})
            if not result_received:
                await output.put({"event": "error", "data": {
                    "code": "voice_timeout", "status": 503, "message": "本轮讲解没有完成，请重试"}})
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception:
            await output.put({"event": "error", "data": {
                "code": "voice_processing_failed", "status": 503, "message": "本轮语音处理没有完成，请重试"}})
        finally:
            await cancel_worker()
            with suppress(Exception):
                await source.aclose()
            if not cancelled:
                await output.put({"event": "voice_done", "data": {**metrics, "total_ms": elapsed()}})
                await output.put(None)

    producer = asyncio.create_task(run())
    try:
        while True:
            event = await output.get()
            if event is None:
                break
            yield event
    finally:
        producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)
