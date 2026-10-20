import os
from pathlib import Path
import tempfile
from urllib.parse import urlparse

from dotenv import set_key
from fastapi import HTTPException

from app.config import Settings


def model_status(state):
    settings = state.settings
    return {"mode": settings.llm_mode, "api_base_url": settings.llm_api_base_url,
            "provider": settings.llm_provider,
            "model": settings.llm_model, "key_configured": bool(settings.llm_api_key.get_secret_value()),
            "verification": state.model_verification, "last_error": state.model_last_error,
            "config_writable": settings.environment == "development"}


def save_model_config(state, payload):
    if state.settings.environment != "development":
        raise HTTPException(403, "正式环境请通过服务器环境变量配置模型")
    with state.model_config_lock:
        current = state.settings
        url = str(payload.api_base_url).rstrip("/")
        old_host = urlparse(current.llm_api_base_url).netloc
        if (current.llm_api_key.get_secret_value() and (old_host, current.llm_provider) != (urlparse(url).netloc, payload.provider)
                and payload.api_key is None):
            raise HTTPException(422, "切换模型平台时，请填写该平台的 API Key")
        values = current.model_dump()
        values.update(llm_mode="live", llm_provider=payload.provider, llm_api_base_url=url,
                      llm_model=payload.model or ("非遗讲解人" if payload.provider == "dify" else ""))
        if payload.api_key is not None:
            values["llm_api_key"] = payload.api_key
        try:
            updated = Settings(_env_file=None, **values)
        except ValueError:
            raise HTTPException(422, "请检查 HTTPS 接口基础地址、模型名称与 API Key 是否完整；地址不要包含查询参数或 /chat/completions") from None
        if urlparse(url).path.rstrip("/").endswith(("/chat/completions", "/chat-messages")):
            raise HTTPException(422, "请填写基础地址，末尾不要包含 /chat/completions 或 /chat-messages")
        persist_environment(state, {"LLM_MODE": "live", "LLM_PROVIDER": updated.llm_provider,
                                   "LLM_API_BASE_URL": updated.llm_api_base_url,
                                   "LLM_MODEL": updated.llm_model,
                                   "LLM_API_KEY": updated.llm_api_key.get_secret_value()})
        state.settings = updated
        state.model_verification = "unverified"
        state.model_last_error = None
        return model_status(state)


def persist_environment(state, values):
    """Caller holds model_config_lock, preserving other configuration fields."""
    path = Path(state.configuration_path)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".model-config-", delete=False) as handle:
            temp_path = Path(handle.name)
            if path.exists():
                handle.write(path.read_text(encoding="utf-8"))
        os.chmod(temp_path, 0o600)
        for key, value in values.items():
            set_key(str(temp_path), key, value, quote_mode="always")
        os.replace(temp_path, path)
    except OSError:
        raise HTTPException(503, "配置文件暂时无法保存，请检查后端目录权限") from None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
