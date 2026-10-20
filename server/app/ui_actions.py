"""Resolve explicit visitor commands against the published catalog, then await the UI.

This lightweight command router does not treat an LLM's prose as executable code.
Questions still use Dify; ambiguous commands produce choices instead of guessing.
"""
import hashlib
import json
import re
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from app.content import get_item
from app.conversation import session_dict
from app.models import HeritageItem, UIAction, utcnow
from app.recognition import playback_command

ACTION_TYPES = ["open_item", "focus_hotspot", "audio_pause", "audio_resume", "audio_repeat", "audio_stop"]
POLITE = re.compile(r"^(?:(?:你好|请你|请|麻烦你|麻烦|能不能|可不可以|可以|我想要|我想|想要|帮我|给我|带我)\s*)+")
COMMAND = re.compile(r"^(打开|切换到|切换至|跳转到|选中|选择|查看|看一下|看看|看一看|去看看|去看|观察|定位到|聚焦到|聚焦|展示|讲讲|介绍一下|介绍|讲解一下|讲解|说说)\s*(.+)$")
OPEN_VERBS = {"打开", "切换到", "切换至", "跳转到", "选中", "选择"}
REFERENCES = {"这个", "它", "这件藏品", "当前藏品", "当前物品", "这件物品"}


def normalize(value):
    return re.sub(r"[\s·•—-]+", "", value).removesuffix("演示").lower()


def candidates(reference, values, name):
    direct = [value for value in values if reference.strip() == getattr(value, "key", value.id)]
    if direct:
        return direct
    query = normalize(reference)
    if not query:
        return []
    exact = [value for value in values if query == normalize(name(value))]
    if exact:
        return exact
    return [value for value in values if len(query) >= 2 and query in normalize(name(value))]


def item_choices(items):
    return [{"label": item.name + "（" + item.id + "）", "text": "打开 " + item.id} for item in items[:8]]


def resolve_command(db, session, text):
    phrase = text.strip().rstrip("。！？!?.,，；; ")
    phrase = POLITE.sub("", phrase).strip()
    phrase = re.sub(r"(?:一下|吧|好吗|好不好|吗)$", "", phrase).strip()
    inverted = re.fullmatch(r"把\s*(.+?)\s*(?:给我)?打开", phrase)
    if inverted:
        phrase = "打开 " + inverted.group(1)
    playback = playback_command(phrase)
    if playback:
        return {"type": playback, "item_id": session.current_item_id, "hotspot_id": session.current_hotspot_id}
    # Negative or compound commands are never silently simplified into an action.
    without_negative = re.sub(r"^(?:不要|别|不必|不用)\s*", "", phrase)
    if without_negative != phrase and COMMAND.match(without_negative):
        return {"clarify": "我没有执行界面操作。你可以直接告诉我希望打开的藏品或观察的部位。"}
    match = COMMAND.fullmatch(phrase)
    if not match:
        return {"ask": text}
    verb, reference = match.groups()
    if any(word in reference for word in ("然后", "并且", "同时", "顺便", "不要", "别打开", "以及")) or re.search(r"[，,;；。！？!?]", reference):
        return {"clarify": "请一次告诉我一个操作，例如“打开青花缠枝莲纹碗”或“看看碗心”。"}
    # Question-like phrases such as “介绍这只碗为什么...” stay questions.
    if any(word in reference for word in ("为什么", "怎么", "如何", "是什么", "有什么", "是否", "能否", "会不会")):
        return {"ask": text}
    items = db.scalars(select(HeritageItem).where(HeritageItem.published.is_(True)).order_by(HeritageItem.id)).all()
    current = next((item for item in items if item.id == session.current_item_id), None)
    if reference in REFERENCES:
        if not current:
            return {"clarify": "你想打开哪件藏品？", "choices": item_choices(items)}
        return {"type": "open_item", "item_id": current.id, "hotspot_id": None}
    if current:
        references = REFERENCES | ({"这个碗", "这只碗"} if "碗" in current.name else set())
        for pointer in references:
            if reference.startswith(pointer + "的"):
                matches = candidates(reference[len(pointer) + 1:], current.hotspots, lambda h: h.name)
                if len(matches) == 1:
                    return {"type": "focus_hotspot", "item_id": current.id, "hotspot_id": matches[0].key}
                return hotspot_clarification(current, matches or current.hotspots)
    # A qualified reference can name a different item and one of its registered parts.
    qualified = []
    for item in items:
        for label in (item.name, re.sub(r"\s*·\s*演示$", "", item.name), item.id):
            if reference.startswith(label + "的"):
                qualified.append((item, reference[len(label) + 1:]))
                break
    if qualified:
        if len(qualified) != 1:
            return {"clarify": "有多件同名藏品，请先选择其中一件。", "choices": item_choices([v[0] for v in qualified])}
        item, part = qualified[0]
        matches = candidates(part, item.hotspots, lambda h: h.name)
        if len(matches) == 1:
            return {"type": "focus_hotspot", "item_id": item.id, "hotspot_id": matches[0].key}
        return hotspot_clarification(item, matches or item.hotspots)
    matches = candidates(reference, items, lambda item: item.name)
    parts = candidates(reference, current.hotspots, lambda h: h.name) if current else []
    if matches and parts and verb not in OPEN_VERBS:
        return {"clarify": "这个名称同时对应藏品和部位，请说完整的藏品名或部位名。"}
    if len(matches) == 1:
        return {"type": "open_item", "item_id": matches[0].id, "hotspot_id": None}
    if len(matches) > 1:
        return {"clarify": "查到多件匹配的藏品，请选择你要打开的那一件。", "choices": item_choices(matches)}
    if verb not in OPEN_VERBS and current:
        if len(parts) == 1:
            return {"type": "focus_hotspot", "item_id": current.id, "hotspot_id": parts[0].key}
        if parts:
            return hotspot_clarification(current, parts)
    # Ordinary introduction questions with no registered UI target still reach Dify.
    if verb in {"讲讲", "介绍一下", "介绍", "讲解一下", "讲解", "说说"}:
        return {"ask": text}
    return {"clarify": "没有找到可以操作的藏品或部位，请说完整名称，或选择下方目标。",
            "choices": item_choices(items) if verb in OPEN_VERBS or not current else hotspot_clarification(current, current.hotspots)["choices"]}


def hotspot_clarification(item, hotspots):
    return {"clarify": "请确认你想观察的部位。", "choices": [
        {"label": h.name, "text": "看看 " + item.id + "的" + h.name} for h in hotspots[:8]]}


def ticket(action):
    return {"id": action.id, "type": action.action_type, "item_id": action.item_id,
            "hotspot_id": action.hotspot_id, "expected_revision": action.revision,
            "expires_at": action.expires_at.isoformat() + "Z"}


def pending_actions(db, session):
    return db.scalars(select(UIAction).where(UIAction.session_id == session.id, UIAction.status == "pending")).all()


def ui_state(db, session):
    action = next((a for a in pending_actions(db, session) if a.expires_at > utcnow() and a.revision == session.revision), None)
    return {"session": session_dict(session), "pending_action": ticket(action) if action else None, "action_types": ACTION_TYPES}


def ensure_revision(session, expected):
    if session.revision != expected:
        raise HTTPException(409, "界面状态已经更新，请刷新状态后重新操作")


def commit(db):
    try:
        db.commit()
    except (StaleDataError, IntegrityError):
        db.rollback()
        raise HTTPException(409, "同一个会话有另一条操作先完成，请刷新状态后重试") from None


def cancel_pending(db, session):
    for previous in pending_actions(db, session):
        previous.status = "cancelled"


def require_no_pending_action(db, session):
    now = utcnow()
    if any(action.expires_at > now and action.revision == session.revision for action in pending_actions(db, session)):
        raise HTTPException(409, "请先完成或取消当前界面操作，再开始新的讲解")


def sync_context(db, session, payload):
    ensure_revision(session, payload.expected_revision)
    item = get_item(db, payload.item_id)
    if payload.hotspot_id and not any(h.key == payload.hotspot_id for h in item.hotspots):
        raise HTTPException(404, "这个物品没有该部位")
    cancel_pending(db, session)
    session.current_item_id, session.current_hotspot_id = item.id, payload.hotspot_id
    session.revision += 1
    commit(db)
    return ui_state(db, session)


def cancel_ui(db, session, payload):
    ensure_revision(session, payload.expected_revision)
    cancel_pending(db, session)
    # Advance even if no ticket is visible yet: an in-flight old plan must conflict.
    session.revision += 1
    commit(db)
    return ui_state(db, session)


def plan_action(db, session, payload):
    digest = hashlib.sha256(json.dumps(payload.model_dump(mode="json"), sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    previous = db.scalar(select(UIAction).where(UIAction.session_id == session.id,
                                              UIAction.client_request_id == str(payload.client_request_id)))
    base = {"session": session_dict(session), "choices": [], "resolver": "local_commands"}
    if previous:
        if previous.request_hash != digest:
            raise HTTPException(409, "同一请求编号不能用于不同的操作")
        if previous.status == "pending" and previous.expires_at > utcnow() and previous.revision == session.revision:
            return {**base, "decision": "action", "message": "等待界面执行。", "action": ticket(previous)}
        return {**base, "decision": "completed", "message": "这条操作已处理或失效，没有再次执行。"}
    ensure_revision(session, payload.expected_revision)
    intent = resolve_command(db, session, payload.text)
    cancel_pending(db, session)
    session.revision += 1
    if "type" not in intent:
        commit(db)
        base["session"] = session_dict(session)
        if "ask" in intent:
            if not session.current_item_id:
                return {**base, "decision": "clarify", "message": "请先选择要了解的藏品。"}
            return {**base, "decision": "ask", "message": "正在准备讲解。", "interaction": {
                "event": "ask", "item_id": session.current_item_id, "question": payload.text}}
        return {**base, "decision": "clarify", "message": intent["clarify"], "choices": intent.get("choices", [])}
    if intent["type"] not in payload.supported_actions:
        commit(db)
        return {**base, "session": session_dict(session), "decision": "clarify", "message": "当前页面还不支持这个操作，没有执行界面切换。"}
    action = UIAction(session_id=session.id, client_request_id=str(payload.client_request_id), request_hash=digest,
                      revision=session.revision, action_type=intent["type"], item_id=intent["item_id"],
                      hotspot_id=intent["hotspot_id"], expires_at=utcnow() + timedelta(seconds=60))
    db.add(action)
    commit(db)
    return {**base, "session": session_dict(session), "decision": "action", "message": "正在执行界面操作。", "action": ticket(action)}


def receive_receipt(db, session, action_id, payload):
    action = db.get(UIAction, action_id)
    if action is None or action.session_id != session.id:
        raise HTTPException(404, "界面操作不存在")
    receipt = payload.model_dump(mode="json")
    if action.receipt is not None:
        if action.receipt != receipt:
            raise HTTPException(409, "这条操作已经收到其他执行结果")
        return {"action_id": action.id, "status": action.status, "duplicate": True,
                "message": "执行结果已记录，没有重复触发讲解。", "session": session_dict(session)}
    if action.status != "pending":
        raise HTTPException(409, "这条界面操作已取消或失效")
    if action.expires_at <= utcnow():
        action.status = "expired"
        commit(db)
        raise HTTPException(410, "这条界面操作已超时，请重新发出指令")
    ensure_revision(session, payload.expected_revision)
    if action.revision != payload.expected_revision:
        raise HTTPException(409, "执行结果对应的是旧界面状态")
    interaction = None
    message = {"failed": "界面操作未完成。", "unsupported": "当前页面不支持这个操作。", "cancelled": "界面操作已取消。"}.get(payload.status, "播放操作已完成。")
    if payload.status == "applied":
        if (payload.actual_item_id, payload.actual_hotspot_id) != (action.item_id, action.hotspot_id):
            raise HTTPException(422, "前端实际显示的物品或部位与目标不一致")
        if action.action_type in ("open_item", "focus_hotspot"):
            item = get_item(db, action.item_id)
            hotspot = next((h for h in item.hotspots if h.key == action.hotspot_id), None)
            if action.action_type == "focus_hotspot" and hotspot is None:
                raise HTTPException(404, "这个部位已不可用，请刷新藏品资料")
            session.current_item_id, session.current_hotspot_id = action.item_id, action.hotspot_id
            interaction = {"event": "hotspot", "item_id": item.id, "hotspot_id": hotspot.key} if hotspot else {"event": "explain", "item_id": item.id}
            message = "已定位到“" + hotspot.name + "”。" if hotspot else "已打开“" + item.name + "”。"
        else:
            expected = {"audio_pause": "paused", "audio_resume": "playing", "audio_repeat": "playing", "audio_stop": "stopped"}[action.action_type]
            if payload.playback_state != expected:
                raise HTTPException(422, "播放器实际状态与操作目标不一致")
            message = {"audio_pause": "讲解已暂停。", "audio_resume": "正在继续播放。",
                       "audio_repeat": "已重播已有讲解。", "audio_stop": "讲解已停止。"}[action.action_type]
    action.status, action.receipt = payload.status, receipt
    session.revision += 1
    commit(db)
    return {"action_id": action.id, "status": action.status, "duplicate": False,
            "message": message, "session": session_dict(session), "interaction": interaction}
