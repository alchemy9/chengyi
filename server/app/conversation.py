import asyncio
import secrets
from dataclasses import dataclass
from datetime import timedelta
from time import monotonic

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm.exc import StaleDataError

from app.content import get_item, retrieve
from app.llm import ModelUnavailable, build_messages, demo_answer, stream_model
from app.models import Message, ModelCall, VisitorSession, utcnow
from app.security import hash_token


def session_dict(session):
    return {"id": session.id, "current_item_id": session.current_item_id,
            "current_hotspot_id": session.current_hotspot_id, "audience": session.audience,
            "turn_count": session.turn_count, "revision": session.revision,
            "expires_at": session.expires_at.isoformat() + "Z"}


def create_session(db, payload, settings):
    if payload.item_id:
        get_item(db, payload.item_id)
    token = secrets.token_urlsafe(32)
    session = VisitorSession(token_hash=hash_token(token), current_item_id=payload.item_id,
                             audience=payload.audience,
                             expires_at=utcnow() + timedelta(hours=settings.session_ttl_hours))
    db.add(session)
    db.commit()
    return {"session": session_dict(session), "session_token": token}


def authenticate_session(db, session_id, token):
    session = db.get(VisitorSession, session_id)
    if session is None or not token or not secrets.compare_digest(session.token_hash, hash_token(token)):
        raise HTTPException(404, "会话不存在或凭证无效")
    if session.expires_at <= utcnow():
        raise HTTPException(410, "会话已过期，请开始新的对话")
    return session


@dataclass
class PreparedInteraction:
    session: VisitorSession
    item: object
    hotspot: object | None
    sources: list[dict]
    actions: list[dict]
    instruction: str


def prepare_interaction(db, session, payload):
    item_id = payload.item_id or session.current_item_id
    if not item_id:
        raise HTTPException(422, "请先选择要了解的物品")
    item = get_item(db, item_id)
    if item_id != session.current_item_id or payload.event == "explain":
        session.current_hotspot_id = None
    hotspot = None
    actions = []
    if payload.event == "hotspot":
        hotspot = next((h for h in item.hotspots if h.key == payload.hotspot_id), None)
        if hotspot is None:
            raise HTTPException(404, "这个物品没有该部位")
        session.current_hotspot_id = hotspot.key
        actions = [{"type": hotspot.action_type, "target": hotspot.action_target}]
    elif payload.event == "ask" and session.current_hotspot_id:
        hotspot = next((h for h in item.hotspots if h.key == session.current_hotspot_id), None)
        if hotspot is None:
            session.current_hotspot_id = None
    session.current_item_id = item_id
    if payload.event == "ask":
        instruction = payload.question
        if hotspot:
            instruction = "当前正在观察“" + hotspot.name + "”。参观者追问：" + instruction
    elif hotspot:
        instruction = "请讲解当前物品的这个部位：" + hotspot.name
    else:
        instruction = "请介绍当前物品，并引导参观者观察可点击的部位。"
    return PreparedInteraction(session, item, hotspot, retrieve(item, payload.question or "", hotspot),
                               actions, instruction)


async def execute_interaction(db, prepared, payload, settings, request_id, transport=None, voice=False):
    session, item = prepared.session, prepared.item
    started = monotonic()
    usage = {}
    error_code = None
    mode = settings.llm_mode
    model_sources = []

    def record_call(call_mode, code=None):
        db.add(ModelCall(session_id=session.id, request_id=request_id,
                         model=settings.llm_model if settings.llm_mode == "live" else "local-demo",
                         mode=call_mode, latency_ms=int((monotonic() - started) * 1000),
                         prompt_tokens=usage.get("prompt_tokens"), completion_tokens=usage.get("completion_tokens"),
                         error_code=code))

    yield {"event": "start", "data": {"request_id": request_id, "session_id": session.id}}
    try:
        if mode == "live":
            history = list(reversed(db.scalars(select(Message).where(
                Message.session_id == session.id, Message.item_id == item.id,
                Message.mode.in_(["live", "question"])
            ).order_by(Message.created_at.desc()).limit(10)).all()))
            messages = build_messages(item, prepared.sources, history, session.audience, prepared.instruction)
            if voice:
                messages[0]["content"] += "\n本轮需要语音朗读。第一句简短并直接回答，默认两到四个短句、约八十至一百五十字，不朗读引用编号、长网址或思考过程。"
            parts = []
            try:
                async for chunk in stream_model(settings, messages, transport, user=session.id):
                    if chunk.replace:
                        parts = []
                        model_sources = []
                        yield {"event": "reset", "data": {"reason": "model_replacement"}}
                    if chunk.usage:
                        usage.update(chunk.usage)
                    if chunk.sources:
                        model_sources = chunk.sources
                    if chunk.text:
                        parts.append(chunk.text)
                        yield {"event": "delta", "data": {"text": chunk.text}}
                text = "".join(parts)
            except ModelUnavailable as exc:
                error_code = exc.code
                if not settings.llm_fallback_enabled:
                    db.rollback()
                    record_call("error", error_code)
                    db.commit()
                    yield {"event": "error", "data": {"code": error_code, "status": 503,
                           "message": "大模型暂时不可用，请稍后重试", "request_id": request_id}}
                    return
                mode = "fallback"
                text = demo_answer(item, prepared.sources, payload.event, payload.question, prepared.hotspot)
                text = text.replace("【演示讲解，尚未接入大模型】", "【模型暂时不可用，以下为资料讲解】")
                yield {"event": "reset", "data": {"reason": "fallback"}}
        else:
            text = demo_answer(item, prepared.sources, payload.event, payload.question, prepared.hotspot)
        if mode != "live":
            for offset in range(0, len(text), 32):
                yield {"event": "delta", "data": {"text": text[offset:offset + 32]}}
        session.turn_count += 1
        db.add(Message(session_id=session.id, item_id=item.id, role="user", content=prepared.instruction,
                       mode="question" if mode == "live" else "demo"))
        message = Message(session_id=session.id, item_id=item.id, role="assistant",
                          content=text, mode=mode, actions=prepared.actions)
        db.add(message)
        record_call(mode, error_code)
        db.commit()
        yield {"event": "result", "data": {
            "request_id": request_id, "message_id": message.id, "text": text, "mode": mode,
            "actions": prepared.actions, "session": session_dict(session), "usage": usage,
            "sources": ([{k: v for k, v in s.items() if k != "content"} for s in prepared.sources]
                        + (model_sources if mode == "live" else [])),
            "suggestions": ["它的制作过程是什么？", "有哪些值得观察的细节？"],
            "warning": "示例资料仅用于联调，需要替换并审核" if item.is_demo else None,
            "provider_error": error_code,
        }}
    except StaleDataError:
        db.rollback()
        record_call("error", "session_conflict")
        db.commit()
        yield {"event": "error", "data": {"code": "session_conflict", "status": 409,
               "message": "同一个会话有另一条请求先完成，请刷新状态后重试", "request_id": request_id}}
    except SQLAlchemyError:
        db.rollback()
        yield {"event": "error", "data": {"code": "database_unavailable", "status": 503,
               "message": "数据服务暂时不可用，请刷新状态后再试", "request_id": request_id}}
    except asyncio.CancelledError:
        db.rollback()
        raise
