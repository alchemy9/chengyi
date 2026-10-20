"""Short PCM WAV uploads use the Dify workspace's configured speech recognizer."""
import asyncio
import io
from time import monotonic
import wave

import httpx
from fastapi import HTTPException

MAX_AUDIO_BYTES = 1024 * 1024


def validate_wav(content):
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "录音过大，请控制在 30 秒以内")
    try:
        with wave.open(io.BytesIO(content), "rb") as audio:
            frames = audio.getnframes()
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, "NONE"):
                raise HTTPException(422, "请上传单声道、16kHz、16 位 PCM 的 WAV 录音")
            if frames < 3200 or frames > 480000:
                raise HTTPException(422, "录音长度应在 0.2 到 30 秒之间")
            if len(audio.readframes(frames)) != frames * 2:
                raise HTTPException(422, "录音文件不完整，请重新录音")
    except (wave.Error, EOFError):
        raise HTTPException(422, "录音不是有效的 WAV 文件") from None


def playback_command(text):
    normalized = text.strip().rstrip("。！？!?.,，；; ")
    groups = {
        "audio_pause": {"暂停", "暂停讲解", "暂停播放", "先停一下"},
        "audio_resume": {"继续", "继续讲", "继续讲解", "继续播放"},
        "audio_repeat": {"再讲一遍", "重播", "重新播放", "重复一遍"},
        "audio_stop": {"停止讲解", "停止播放"},
    }
    return next((command for command, aliases in groups.items() if normalized in aliases), None)


async def transcribe(settings, content, session_id, transport=None):
    validate_wav(content)
    if settings.llm_mode != "live" or settings.llm_provider != "dify":
        raise HTTPException(422, "语音输入需要先接入 Dify 应用")
    started = monotonic()
    try:
        async with asyncio.timeout(settings.llm_timeout_seconds):
            async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds, transport=transport,
                                         follow_redirects=False) as client:
                response = await client.post(settings.llm_api_base_url.rstrip("/") + "/audio-to-text",
                    headers={"Authorization": "Bearer " + settings.llm_api_key.get_secret_value()},
                    data={"user": "heritage-" + session_id}, files={"file": ("recording.wav", content, "audio/wav")})
                if response.status_code != 200:
                    raise HTTPException(503, "语音识别失败，请检查 Dify 工作区默认识别模型及账号额度")
                try:
                    result = response.json()
                except ValueError:
                    raise HTTPException(503, "语音识别服务返回异常，请稍后重试") from None
    except (TimeoutError, httpx.TimeoutException):
        raise HTTPException(503, "语音识别超时，请缩短录音后重试") from None
    except httpx.HTTPError:
        raise HTTPException(503, "暂时无法连接语音识别服务，请稍后重试") from None
    text = result.get("text") if isinstance(result, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(422, "没有识别到清楚的语音，请重新说一遍")
    if len(text) > 2000:
        raise HTTPException(422, "识别内容过长，请缩短录音")
    text = text.strip()
    return {"text": text, "command": playback_command(text), "latency_ms": int((monotonic() - started) * 1000)}
