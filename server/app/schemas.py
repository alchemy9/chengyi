from typing import Generic, Literal, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, SecretStr, StringConstraints, model_validator
from typing_extensions import Annotated

Identifier = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_-]{1,64}$")]
ActionType = Literal["highlight", "play_animation", "show_steps"]
EventType = Literal["explain", "hotspot", "ask"]


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class HotspotInput(InputModel):
    key: Identifier
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=6000)
    action_type: ActionType = "highlight"
    action_target: str = Field(min_length=1, max_length=120)


class KnowledgeInput(InputModel):
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=12000)
    source_name: str = Field(min_length=1, max_length=200)
    source_url: HttpUrl | None = None
    reviewed: bool = False


class ItemInput(InputModel):
    id: Identifier
    name: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=80)
    region: str = Field(default="", max_length=120)
    summary: str = Field(min_length=1, max_length=1500)
    introduction: str = Field(min_length=1, max_length=12000)
    image_url: HttpUrl | None = None
    published: bool = False
    is_demo: bool = False
    hotspots: list[HotspotInput] = Field(default_factory=list, max_length=30)
    knowledge: list[KnowledgeInput] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def unique_hotspots(self):
        if len({h.key for h in self.hotspots}) != len(self.hotspots):
            raise ValueError("同一物品的热点编号不能重复")
        return self


class SessionInput(InputModel):
    item_id: Identifier | None = None
    audience: Literal["general", "children", "expert"] = "general"


class InteractionInput(InputModel):
    event: EventType
    item_id: Identifier | None = None
    hotspot_id: Identifier | None = None
    question: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def event_fields(self):
        if self.event == "ask" and not self.question:
            raise ValueError("提问时请提供 question")
        if self.event != "ask" and self.question is not None:
            raise ValueError("只有 ask 事件可以提供 question")
        if self.event == "hotspot" and not self.hotspot_id:
            raise ValueError("点击部位时请提供 hotspot_id")
        if self.event != "hotspot" and self.hotspot_id is not None:
            raise ValueError("只有 hotspot 事件可以提供 hotspot_id")
        return self


class LoginInput(InputModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=300)


T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    data: T
    request_id: str


class ItemPublic(BaseModel):
    id: str
    name: str
    category: str
    region: str
    summary: str
    introduction: str
    image_url: str | None
    is_demo: bool
    hotspots: list[HotspotInput]


class ItemAdmin(ItemPublic):
    published: bool
    knowledge: list[KnowledgeInput]


class ItemPage(BaseModel):
    items: list[ItemPublic]
    total: int
    page: int
    page_size: int


class SessionState(BaseModel):
    id: str
    current_item_id: str | None
    current_hotspot_id: str | None
    audience: Literal["general", "children", "expert"]
    turn_count: int
    revision: int
    expires_at: str


class SessionCreated(BaseModel):
    session: SessionState
    session_token: str


class Action(BaseModel):
    type: Literal["highlight", "play_animation", "show_steps"]
    target: str


class SourceReference(BaseModel):
    id: str
    title: str
    source_name: str
    source_url: str | None
    is_demo: bool


class Reply(BaseModel):
    request_id: str
    message_id: str
    text: str
    mode: Literal["demo", "live", "fallback"]
    actions: list[Action]
    session: SessionState
    usage: dict[str, int]
    sources: list[SourceReference]
    suggestions: list[str]
    warning: str | None
    provider_error: str | None


class MessageOutput(BaseModel):
    id: str
    item_id: str | None
    role: str
    text: str
    mode: str
    actions: list[Action]
    created_at: str


class LoginOutput(BaseModel):
    access_token: str
    token_type: Literal["bearer"]
    expires_in: int


class HealthOutput(BaseModel):
    status: str
    version: str
    llm_mode: str


class ModelConfigInput(InputModel):
    provider: Literal["chat_completions", "dify"] = "chat_completions"
    api_base_url: HttpUrl
    model: str = Field(default="", max_length=120)
    api_key: SecretStr | None = None

    @model_validator(mode="after")
    def key_format(self):
        if self.api_key is not None:
            value = self.api_key.get_secret_value()
            if not value or len(value) > 4096 or any(c.isspace() for c in value):
                raise ValueError("API Key 不能为空，也不能包含空格或换行")
        return self


class ModelStatus(BaseModel):
    mode: Literal["demo", "live"]
    provider: Literal["chat_completions", "dify"]
    api_base_url: str
    model: str
    key_configured: bool
    verification: Literal["unverified", "verified", "failed"]
    config_writable: bool
    last_error: str | None


class ModelProbe(BaseModel):
    connected: bool
    reply: str
    latency_ms: int
    usage: dict[str, int]


class SpeechConfigInput(InputModel):
    enabled: bool = True
    api_key: SecretStr | None = None
    voice: Literal["alex", "benjamin", "charles", "david", "anna", "bella"] = "anna"

    @model_validator(mode="after")
    def key_format(self):
        if self.api_key is not None:
            value = self.api_key.get_secret_value()
            if not value or len(value) > 4096 or any(c.isspace() for c in value):
                raise ValueError("API Key 不能为空，也不能包含空格或换行")
        return self


class SpeechStatus(BaseModel):
    enabled: bool
    key_configured: bool
    voice: str
    model: str
    config_writable: bool
    recognition_enabled: bool = False


class SpeechProbe(BaseModel):
    audio_base64: str
    mime_type: str
    first_byte_ms: int
    total_ms: int


class VoiceTranscription(BaseModel):
    text: str
    command: Literal["audio_pause", "audio_resume", "audio_repeat", "audio_stop"] | None
    latency_ms: int


UIActionType = Literal["open_item", "focus_hotspot", "audio_pause", "audio_resume", "audio_repeat", "audio_stop"]


class UIPlanInput(InputModel):
    text: str = Field(min_length=1, max_length=2000)
    expected_revision: int = Field(ge=1)
    client_request_id: UUID
    supported_actions: list[UIActionType] = Field(max_length=6)


class UIContextInput(InputModel):
    expected_revision: int = Field(ge=1)
    item_id: Identifier
    hotspot_id: Identifier | None = None


class UICancelInput(InputModel):
    expected_revision: int = Field(ge=1)


class UIReceiptInput(InputModel):
    expected_revision: int = Field(ge=1)
    status: Literal["applied", "failed", "unsupported", "cancelled"]
    actual_item_id: Identifier | None = None
    actual_hotspot_id: Identifier | None = None
    playback_state: Literal["playing", "paused", "stopped"] | None = None


class UIActionTicket(BaseModel):
    id: str
    type: UIActionType
    item_id: str | None
    hotspot_id: str | None
    expected_revision: int
    expires_at: str


class UIChoice(BaseModel):
    label: str
    text: str


class UIPlanResult(BaseModel):
    decision: Literal["action", "ask", "clarify", "completed"]
    message: str
    session: SessionState
    action: UIActionTicket | None = None
    interaction: InteractionInput | None = None
    choices: list[UIChoice] = Field(default_factory=list)
    resolver: Literal["local_commands"] = "local_commands"


class UIState(BaseModel):
    session: SessionState
    pending_action: UIActionTicket | None
    action_types: list[UIActionType]


class UIReceiptResult(BaseModel):
    action_id: str
    status: Literal["applied", "failed", "unsupported", "cancelled"]
    duplicate: bool
    message: str
    session: SessionState
    interaction: InteractionInput | None = None
