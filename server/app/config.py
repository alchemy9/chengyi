from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True)

    environment: Literal["development", "production"] = "development"
    database_url: str = "sqlite:///./data/heritage.db"
    admin_username: str = "admin"
    admin_password: SecretStr
    secret_key: SecretStr
    cors_origins: list[str] = Field(default_factory=list)
    seed_demo_data: bool = False
    llm_mode: Literal["demo", "live"] = "demo"
    llm_provider: Literal["chat_completions", "dify"] = "chat_completions"
    llm_api_base_url: str = ""
    llm_api_key: SecretStr = SecretStr("")
    llm_model: str = ""
    llm_timeout_seconds: float = Field(default=45, ge=1, le=180)
    llm_max_tokens: int = Field(default=1200, ge=64, le=8192)
    llm_fallback_enabled: bool = True
    speech_enabled: bool = False
    speech_api_key: SecretStr = SecretStr("")
    speech_voice: Literal["alex", "benjamin", "charles", "david", "anna", "bella"] = "anna"
    speech_timeout_seconds: float = Field(default=45, ge=1, le=180)
    session_ttl_hours: int = Field(default=24, ge=1, le=168)

    @model_validator(mode="after")
    def validate_configuration(self):
        if len(self.admin_password.get_secret_value()) < 12:
            raise ValueError("管理员密码至少 12 位；先运行 scripts/bootstrap.py")
        if len(self.secret_key.get_secret_value()) < 32:
            raise ValueError("SECRET_KEY 至少 32 位；先运行 scripts/bootstrap.py")
        if "*" in self.cors_origins:
            raise ValueError("请列出允许接入的前端地址，不要设置通配符")
        if self.llm_mode == "live":
            url = urlparse(self.llm_api_base_url)
            if url.scheme != "https" or not url.netloc or url.username or url.password or url.query or url.fragment:
                raise ValueError("真实模型地址必须是无账号密码的 HTTPS 地址")
            if not self.llm_api_key.get_secret_value() or (self.llm_provider == "chat_completions" and not self.llm_model.strip()):
                raise ValueError("live 模式需要模型 Key、接口地址和模型名称")
        if self.speech_enabled and not self.speech_api_key.get_secret_value():
            raise ValueError("启用声音需要填写硅基流动 API Key")
        if self.environment == "production" and self.seed_demo_data:
            raise ValueError("正式环境请关闭 SEED_DEMO_DATA")
        return self
