from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.dialects.mysql import LONGTEXT

from app.db import Base


def utcnow():
    # 数据库统一保存 UTC 无时区时间，API 统一以 Z 标记输出。
    return datetime.now(timezone.utc).replace(tzinfo=None)


def uid():
    return str(uuid4())


class HeritageItem(Base):
    __tablename__ = "heritage_items"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(80))
    region: Mapped[str] = mapped_column(String(120), default="")
    summary: Mapped[str] = mapped_column(Text)
    introduction: Mapped[str] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    published: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    hotspots: Mapped[list["Hotspot"]] = relationship(cascade="all, delete-orphan", order_by="Hotspot.id")
    knowledge: Mapped[list["KnowledgeEntry"]] = relationship(cascade="all, delete-orphan", order_by="KnowledgeEntry.id")


class Hotspot(Base):
    __tablename__ = "hotspots"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    item_id: Mapped[str] = mapped_column(ForeignKey("heritage_items.id"), index=True)
    key: Mapped[str] = mapped_column(String(64))
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text)
    action_type: Mapped[str] = mapped_column(String(40), default="highlight")
    action_target: Mapped[str] = mapped_column(String(120))


class KnowledgeEntry(Base):
    __tablename__ = "knowledge_entries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    item_id: Mapped[str] = mapped_column(ForeignKey("heritage_items.id"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    content: Mapped[str] = mapped_column(Text)
    source_name: Mapped[str] = mapped_column(String(200))
    source_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    reviewed: Mapped[bool] = mapped_column(Boolean, default=False)


class Tour(Base):
    # 仅保留历史结构与旧数据；轻量版不提供路线业务。
    __tablename__ = "tours"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    item_ids: Mapped[list[str]] = mapped_column(JSON)
    published: Mapped[bool] = mapped_column(Boolean, default=False, index=True)


class VisitorSession(Base):
    __tablename__ = "visitor_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    token_hash: Mapped[str] = mapped_column(String(64))
    current_item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    current_hotspot_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tour_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 旧版字段保留以兼容已经保存的数据，轻量版不使用。
    itinerary: Mapped[list[str]] = mapped_column(JSON, default=list)
    position: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(24), default="active")
    audience: Mapped[str] = mapped_column(String(24), default="general")
    turn_count: Mapped[int] = mapped_column(Integer, default=0)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    __mapper_args__ = {"version_id_col": revision}


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("visitor_sessions.id"), index=True)
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    role: Mapped[str] = mapped_column(String(24))
    content: Mapped[str] = mapped_column(Text().with_variant(LONGTEXT(), "mysql"))
    mode: Mapped[str] = mapped_column(String(24), default="control")
    actions: Mapped[list[dict]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class UIAction(Base):
    __tablename__ = "ui_actions"
    __table_args__ = (UniqueConstraint("session_id", "client_request_id", name="uq_ui_action_request"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("visitor_sessions.id"), index=True)
    client_request_id: Mapped[str] = mapped_column(String(36))
    request_hash: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer)
    action_type: Mapped[str] = mapped_column(String(40))
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hotspot_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    receipt: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class InteractionEvent(Base):
    # 历史统计数据保留；轻量版不采集交互统计。
    __tablename__ = "interaction_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("visitor_sessions.id"), index=True)
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    event_type: Mapped[str] = mapped_column(String(24))
    hotspot_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ModelCall(Base):
    __tablename__ = "model_calls"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("visitor_sessions.id"), index=True)
    request_id: Mapped[str] = mapped_column(String(36), index=True)
    model: Mapped[str] = mapped_column(String(120))
    mode: Mapped[str] = mapped_column(String(24))
    latency_ms: Mapped[int] = mapped_column(Integer)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class PotteryProject(Base):
    __tablename__ = "pottery_projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    session_id: Mapped[str] = mapped_column(ForeignKey("visitor_sessions.id"), index=True)
    document: Mapped[dict] = mapped_column(JSON)
    undo: Mapped[list] = mapped_column(JSON, default=list)
    redo: Mapped[list] = mapped_column(JSON, default=list)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    saved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    __mapper_args__ = {"version_id_col": revision}


class PotteryCommand(Base):
    __tablename__ = "pottery_commands"
    __table_args__ = (UniqueConstraint("project_id", "client_request_id", name="uq_pottery_command_request"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    project_id: Mapped[str] = mapped_column(ForeignKey("pottery_projects.id"), index=True)
    client_request_id: Mapped[str] = mapped_column(String(36))
    request_hash: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    result: Mapped[dict] = mapped_column(JSON)
    receipt: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
