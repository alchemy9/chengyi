import asyncio
import base64
from dataclasses import dataclass
from time import monotonic

import httpx
from fastapi import HTTPException

from app.config import Settings
from app.model_config import persist_environment

MODEL = "FunAudioLLM/CosyVoice2-0.5B"
SPEECH_URL = "https://api.siliconflow.cn/v1/audio/speech"
MESSAGES = {
    "speech_identity_required": "硅基流动要求先完成 API Key 所属账号的实名认证",
    "speech_access_denied": "语音账号没有调用权限，请检查硅基流动账号",
    "speech_unauthorized": "语音 API Key 无效，请检查硅基流动配置",
    "speech_rate_limited": "语音服务请求过多，请稍后重试",
    "speech_timeout": "生成声音超时，文字讲解仍然可以查看",
    "speech_connection_error": "暂时无法连接语音服务，文字讲解仍然可以查看",
    "speech_invalid_audio": "语音服务没有返回有效的 MP3 音频",
    "speech_http_error": "语音服务暂时不可用，文字讲解仍然可以查看",
    "speech_limit": "本次讲解较长，声音只播放前 4000 字，完整文字仍可查看",
}


class SpeechUnavailable(Exception):
    def __init__(self, code):
        self.code = code
        self.message = MESSAGES.get(code, "声音生成未完成，文字讲解仍然可以查看")
        super().__init__(code)


@dataclass
class SpeechAudio:
    content: bytes
    first_byte_ms: int
    total_ms: int
    mime_type: str = "audio/mpeg"

    def as_dict(self):
        return {"audio_base64": base64.b64encode(self.content).decode("ascii"),
                "mime_type": self.mime_type, "first_byte_ms": self.first_byte_ms, "total_ms": self.total_ms}


def speech_status(state):
    current = state.settings
    return {"enabled": current.speech_enabled, "voice": current.speech_voice, "model": MODEL,
            "recognition_enabled": current.llm_mode == "live" and current.llm_provider == "dify",
            "key_configured": bool(current.speech_api_key.get_secret_value()),
            "config_writable": current.environment == "development"}


def save_speech_config(state, payload):
    if state.settings.environment != "development":
        raise HTTPException(403, "正式环境请通过服务器环境变量配置声音")
    with state.model_config_lock:
        values = state.settings.model_dump()
        values.update(speech_enabled=payload.enabled, speech_voice=payload.voice)
        if payload.api_key is not None:
            values["speech_api_key"] = payload.api_key
        try:
            updated = Settings(_env_file=None, **values)
        except ValueError:
            raise HTTPException(422, "启用声音需要填写硅基流动 API Key") from None
        persist_environment(state, {"SPEECH_ENABLED": "true" if updated.speech_enabled else "false",
                                   "SPEECH_VOICE": updated.speech_voice,
                                   "SPEECH_API_KEY": updated.speech_api_key.get_secret_value()})
        state.settings = updated
        return speech_status(state)


async def synthesize(settings, text, transport=None, on_first_byte=None):
    """Explicitly request provider streaming; retain one small, independently playable sentence.

    Whole-reply buffering is avoided. Sentence buffering remains deliberate for
    compatibility with browsers without MP3 MediaSource support.
    """
    started = monotonic()
    first_byte = None
    content = bytearray()
    try:
        async with asyncio.timeout(settings.speech_timeout_seconds):
            async with httpx.AsyncClient(timeout=settings.speech_timeout_seconds,
                                         transport=transport, follow_redirects=False) as client:
                async with client.stream("POST", SPEECH_URL, json={
                    "model": MODEL, "voice": MODEL + ":" + settings.speech_voice,
                    "input": text, "response_format": "mp3", "stream": True,
                }, headers={"Authorization": "Bearer " + settings.speech_api_key.get_secret_value()}) as response:
                    if response.status_code != 200:
                        code = {401: "speech_unauthorized", 403: "speech_access_denied",
                                429: "speech_rate_limited"}.get(response.status_code, "speech_http_error")
                        if response.status_code == 403:
                            error_bytes = bytearray()
                            async for part in response.aiter_bytes():
                                error_bytes.extend(part[:65536 - len(error_bytes)])
                                if len(error_bytes) >= 65536:
                                    break
                            detail = error_bytes.decode("utf-8", errors="replace").lower()
                            if "identity verification" in detail or "实名认证" in detail:
                                code = "speech_identity_required"
                        raise SpeechUnavailable(code)
                    async for part in response.aiter_bytes():
                        if not part:
                            continue
                        if first_byte is None:
                            first_byte = int((monotonic() - started) * 1000)
                            if on_first_byte:
                                await on_first_byte(first_byte)
                        content.extend(part)
                        if len(content) > 2 * 1024 * 1024:
                            raise SpeechUnavailable("speech_invalid_audio")
    except (TimeoutError, httpx.TimeoutException):
        raise SpeechUnavailable("speech_timeout") from None
    except httpx.HTTPError:
        raise SpeechUnavailable("speech_connection_error") from None
    if not (content.startswith(b"ID3") or (len(content) >= 2 and content[0] == 0xFF and content[1] & 0xE0 == 0xE0)):
        raise SpeechUnavailable("speech_invalid_audio")
    return SpeechAudio(bytes(content), first_byte or 0, int((monotonic() - started) * 1000))


async def stream_pcm(settings, text, client):
    """Forward mono signed 16-bit little-endian PCM without whole-sentence buffering."""
    pending = b""
    received = 0
    try:
        async with asyncio.timeout(settings.speech_timeout_seconds):
            async with client.stream("POST", SPEECH_URL, json={
                "model": MODEL, "voice": MODEL + ":" + settings.speech_voice,
                "input": text, "response_format": "pcm", "sample_rate": 24000, "stream": True,
            }, headers={"Authorization": "Bearer " + settings.speech_api_key.get_secret_value()}) as response:
                if response.status_code != 200:
                    code = {401: "speech_unauthorized", 403: "speech_access_denied",
                            429: "speech_rate_limited"}.get(response.status_code, "speech_http_error")
                    if response.status_code == 403:
                        detail = bytearray()
                        async for part in response.aiter_bytes():
                            detail.extend(part[:65536 - len(detail)])
                            if len(detail) >= 65536:
                                break
                        if "identity verification" in detail.decode("utf-8", errors="replace").lower():
                            code = "speech_identity_required"
                    raise SpeechUnavailable(code)
                content_type = response.headers.get("content-type", "").lower()
                if "json" in content_type or "text/" in content_type:
                    raise SpeechUnavailable("speech_invalid_audio")
                async for part in response.aiter_bytes():
                    if not part:
                        continue
                    if not received and part.startswith((b"ID3", b"RIFF", b"<html", b'{"error')):
                        raise SpeechUnavailable("speech_invalid_audio")
                    received += len(part)
                    if received > 2 * 1024 * 1024:
                        raise SpeechUnavailable("speech_invalid_audio")
                    pending += part
                    # Align to complete PCM samples and bound each SSE packet.
                    while len(pending) >= 2:
                        size = min(len(pending) - len(pending) % 2, 16384)
                        yield pending[:size]
                        pending = pending[size:]
    except (TimeoutError, httpx.TimeoutException):
        raise SpeechUnavailable("speech_timeout") from None
    except httpx.HTTPError:
        raise SpeechUnavailable("speech_connection_error") from None
    if not received or pending:
        raise SpeechUnavailable("speech_invalid_audio")
