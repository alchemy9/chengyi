from contextlib import asynccontextmanager
import json
import logging
from pathlib import Path
from time import monotonic
from threading import RLock
from uuid import uuid4
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, inspect, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import Settings
from app.content import get_item, item_dict, save_item
from app.db import build_database
from app.conversation import authenticate_session, create_session, execute_interaction, prepare_interaction, session_dict
from app.models import HeritageItem
from app.model_config import model_status, save_model_config
from app.llm import ModelUnavailable, stream_model
from app.speech import SpeechUnavailable, save_speech_config, speech_status, synthesize
from app.voice_stream import stream_voice
from app.recognition import MAX_AUDIO_BYTES, transcribe
from app.ui_actions import cancel_ui, plan_action, receive_receipt, require_no_pending_action, sync_context, ui_state
from app.schemas import (Envelope, HealthOutput, InteractionInput, ItemAdmin, ItemInput,
                         ItemPage, ItemPublic, LoginInput, LoginOutput, ModelConfigInput,
                         ModelProbe, ModelStatus, Reply, SessionCreated, SessionInput, SessionState,
                         SpeechConfigInput, SpeechStatus, SpeechProbe, VoiceTranscription,
                         UICancelInput, UIContextInput, UIPlanInput, UIPlanResult, UIReceiptInput, UIReceiptResult, UIState)
from app.security import RateLimiter, check_password, require_admin, signer
from app.seed import seed_demo
from app.workbench_routes import install as install_workbench

log = logging.getLogger("heritage")
STATIC = Path(__file__).parent / "static"
# 承艺网页（index.html、css、js、assets）就在 server 的上一级目录。
FRONTEND = Path(__file__).resolve().parents[2]
PREFIX = "/api/v1"


class FrontendFiles(StaticFiles):
    """只公开网页需要的目录；server（含 .env、数据库）、tools、docs 等一律 404。"""
    PUBLIC = {"index.html", "css", "js", "assets", "tests"}

    async def get_response(self, path, scope):
        if path not in ("", ".") and path.split("/", 1)[0] not in self.PUBLIC:
            raise StarletteHTTPException(404, "Not Found")
        return await super().get_response(path, scope)


def ok(request, data):
    return {"data": data, "request_id": request.state.request_id}


def db_session(request: Request):
    with request.app.state.db_factory() as db:
        yield db


def rate_limit(request, scope, limit):
    ip = request.client.host if request.client else "unknown"
    request.app.state.limiter.check(scope + ":" + ip, limit)


def create_app(settings: Settings | None = None, model_transport=None, configuration_path=None, speech_transport=None,
               recognition_transport=None):
    settings = settings or Settings()
    engine, factory = build_database(settings.database_url)

    @asynccontextmanager
    async def lifespan(app):
        if "heritage_items" not in inspect(engine).get_table_names():
            raise RuntimeError("数据库尚未初始化，请运行：python -m alembic upgrade head")
        if settings.seed_demo_data:
            with factory() as db:
                seed_demo(db)
        yield
        engine.dispose()

    app = FastAPI(title="承艺 · 非遗讲解与陶艺工作台后端", version="0.3.0", lifespan=lifespan,
                  description="非遗资料、大模型讲解与问答、陶艺工作台 Agent；同时托管承艺网页。",
                  docs_url="/docs" if settings.environment == "development" else None,
                  redoc_url=None, openapi_url="/openapi.json" if settings.environment == "development" else None)
    app.state.settings = settings
    app.state.engine = engine
    app.state.db_factory = factory
    app.state.limiter = RateLimiter()
    app.state.model_transport = model_transport
    app.state.speech_transport = speech_transport
    install_workbench(app, STATIC, db_session, ok, rate_limit)
    app.state.configuration_path = Path(configuration_path or ".env").resolve()
    app.state.model_config_lock = RLock()
    app.state.model_verification = "unverified"
    app.state.model_last_error = None
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "OPTIONS"],
                       allow_headers=["Content-Type", "Authorization", "X-Session-Token"],
                       expose_headers=["X-Request-ID", "Retry-After"])

    @app.middleware("http")
    async def request_context(request, call_next):
        request.state.request_id = str(uuid4())
        started = monotonic()
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > 1024 * 1024):
            response = JSONResponse(status_code=413, content={"error": {"code": "body_too_large",
                "message": "请求内容过大", "request_id": request.state.request_id}})
        else:
            response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        if request.url.path.startswith(PREFIX + "/admin") or "/sessions" in request.url.path or "/workbenches" in request.url.path:
            response.headers["Cache-Control"] = "no-store"
        log.info("request id=%s method=%s status=%s duration_ms=%d", request.state.request_id,
                 request.method, response.status_code, int((monotonic() - started) * 1000))
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, exc):
        return JSONResponse(status_code=exc.status_code, headers=exc.headers, content={"error": {
            "code": "http_" + str(exc.status_code), "message": exc.detail,
            "request_id": request.state.request_id}})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        details = [{"field": ".".join(str(s) for s in e["loc"]), "message": e["msg"]} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"error": {"code": "validation_error",
            "message": "请求内容不符合要求", "details": details, "request_id": request.state.request_id}})

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request, exc):
        # 不回传数据库连接、SQL 参数或异常正文。
        log.error("database failure request_id=%s type=%s", request.state.request_id, type(exc).__name__)
        return JSONResponse(status_code=503, content={"error": {"code": "database_unavailable",
            "message": "数据服务暂时不可用", "request_id": request.state.request_id}})

    @app.get("/admin", include_in_schema=False)
    def dashboard():
        return FileResponse(STATIC / "admin.html")

    @app.get("/demo", include_in_schema=False)
    def demo():
        return FileResponse(STATIC / "demo.html")

    @app.get("/voice", include_in_schema=False)
    def voice_demo():
        return FileResponse(STATIC / "voice.html")

    @app.get("/recording-worklet.js", include_in_schema=False)
    def recording_worklet():
        return FileResponse(STATIC / "recording-worklet.js", media_type="application/javascript")

    @app.get("/pcm-player.js", include_in_schema=False)
    def pcm_player():
        return FileResponse(STATIC / "pcm-player.js", media_type="application/javascript")

    @app.get("/ui-controls.js", include_in_schema=False)
    def ui_controls():
        return FileResponse(STATIC / "ui-controls.js", media_type="application/javascript")

    @app.get(PREFIX + "/voice/status", tags=["语音"], response_model=Envelope[SpeechStatus])
    def voice_status(request: Request):
        return ok(request, speech_status(app.state))

    @app.get("/health", tags=["运行状态"], response_model=Envelope[HealthOutput])
    def health(request: Request, db: Session = Depends(db_session)):
        db.execute(text("SELECT 1"))
        return ok(request, {"status": "ok", "version": "0.3.0", "llm_mode": app.state.settings.llm_mode})

    @app.get(PREFIX + "/items", tags=["物品"], response_model=Envelope[ItemPage])
    def items(request: Request, search: str = Query("", max_length=100),
              category: str = Query("", max_length=80), page: int = Query(1, ge=1),
              page_size: int = Query(20, ge=1, le=100), db: Session = Depends(db_session)):
        query = select(HeritageItem).where(HeritageItem.published.is_(True))
        if search:
            query = query.where(HeritageItem.name.ilike("%" + search + "%"))
        if category:
            query = query.where(HeritageItem.category == category)
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        values = db.scalars(query.order_by(HeritageItem.id).offset((page - 1) * page_size).limit(page_size)).all()
        return ok(request, {"items": [item_dict(i) for i in values], "total": total,
                            "page": page, "page_size": page_size})

    @app.get(PREFIX + "/items/{item_id}", tags=["物品"], response_model=Envelope[ItemPublic])
    def item_detail(item_id: str, request: Request, db: Session = Depends(db_session)):
        return ok(request, item_dict(get_item(db, item_id)))


    @app.post(PREFIX + "/sessions", status_code=201, tags=["会话"], response_model=Envelope[SessionCreated])
    def new_session(payload: SessionInput, request: Request, db: Session = Depends(db_session)):
        rate_limit(request, "new-session", 30)
        return ok(request, create_session(db, payload, app.state.settings))

    @app.get(PREFIX + "/sessions/{session_id}", tags=["会话"], response_model=Envelope[SessionState])
    def read_session(session_id: str, request: Request,
                     x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        return ok(request, session_dict(authenticate_session(db, session_id, x_session_token)))

    @app.get(PREFIX + "/sessions/{session_id}/ui/state", tags=["界面联动"], response_model=Envelope[UIState])
    def read_ui_state(session_id: str, request: Request,
                      x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        return ok(request, ui_state(db, authenticate_session(db, session_id, x_session_token)))

    @app.post(PREFIX + "/sessions/{session_id}/ui/context", tags=["界面联动"], response_model=Envelope[UIState])
    def update_ui_context(session_id: str, payload: UIContextInput, request: Request,
                          x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        session = authenticate_session(db, session_id, x_session_token)
        rate_limit(request, "ui-context-ip", 90)
        return ok(request, sync_context(db, session, payload))

    @app.post(PREFIX + "/sessions/{session_id}/ui/plan", tags=["界面联动"], response_model=Envelope[UIPlanResult])
    def plan_ui(session_id: str, payload: UIPlanInput, request: Request,
                x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        session = authenticate_session(db, session_id, x_session_token)
        rate_limit(request, "ui-plan-ip", 90)
        app.state.limiter.check("ui-plan-session:" + session.id, 60)
        return ok(request, plan_action(db, session, payload))

    @app.post(PREFIX + "/sessions/{session_id}/ui/cancel", tags=["界面联动"], response_model=Envelope[UIState])
    def cancel_ui_actions(session_id: str, payload: UICancelInput, request: Request,
                          x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        session = authenticate_session(db, session_id, x_session_token)
        rate_limit(request, "ui-cancel-ip", 120)
        return ok(request, cancel_ui(db, session, payload))

    @app.post(PREFIX + "/sessions/{session_id}/ui/actions/{action_id}/receipt", tags=["界面联动"],
              response_model=Envelope[UIReceiptResult])
    def acknowledge_ui(session_id: str, action_id: str, payload: UIReceiptInput, request: Request,
                       x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        session = authenticate_session(db, session_id, x_session_token)
        rate_limit(request, "ui-receipt-ip", 120)
        return ok(request, receive_receipt(db, session, action_id, payload))

    @app.post(PREFIX + "/sessions/{session_id}/transcribe", tags=["语音"],
              response_model=Envelope[VoiceTranscription], openapi_extra={"requestBody": {
                  "required": True, "content": {"audio/wav": {"schema": {"type": "string", "format": "binary"}}}}})
    async def recognize(session_id: str, request: Request, x_session_token: str = Header(default=""),
                        db: Session = Depends(db_session)):
        session = authenticate_session(db, session_id, x_session_token)
        rate_limit(request, "recognition-ip", 30)
        app.state.limiter.check("recognition-session:" + session.id, 15)
        if request.headers.get("content-type", "").split(";")[0].lower() != "audio/wav":
            raise HTTPException(415, "请发送 WAV 录音，Content-Type 为 audio/wav")
        content = bytearray()
        async for part in request.stream():
            content.extend(part)
            if len(content) > MAX_AUDIO_BYTES:
                raise HTTPException(413, "录音过大，请控制在 30 秒以内")
        return ok(request, await transcribe(app.state.settings, bytes(content), session.id, recognition_transport))


    def prepare(request, db, session_id, token, payload):
        session = authenticate_session(db, session_id, token)
        require_no_pending_action(db, session)
        rate_limit(request, "interaction-ip", 90)
        app.state.limiter.check("interaction-session:" + session.id, 30)
        return prepare_interaction(db, session, payload)

    @app.post(PREFIX + "/sessions/{session_id}/interact", tags=["交互"], response_model=Envelope[Reply])
    async def interact(session_id: str, payload: InteractionInput, request: Request,
                       x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        prepared = prepare(request, db, session_id, x_session_token, payload)
        async for event in execute_interaction(db, prepared, payload, app.state.settings, request.state.request_id, model_transport):
            if event["event"] == "error":
                return JSONResponse(status_code=event["data"]["status"], content={"error": event["data"]})
            if event["event"] == "result":
                return ok(request, event["data"])

    @app.post(PREFIX + "/sessions/{session_id}/interact/stream", tags=["交互"], response_class=StreamingResponse,
              responses={200: {"description": "SSE：start、delta、reset、result 或 error，详见前端对接说明。",
                               "content": {"text/event-stream": {"schema": {"type": "string"}}}}})
    async def interact_stream(session_id: str, payload: InteractionInput, request: Request,
                              x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        prepared = prepare(request, db, session_id, x_session_token, payload)

        async def events():
            async for event in execute_interaction(db, prepared, payload, app.state.settings, request.state.request_id, model_transport):
                yield "event: " + event["event"] + "\ndata: " + json.dumps(event["data"], ensure_ascii=False) + "\n\n"

        return StreamingResponse(events(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})

    @app.post(PREFIX + "/sessions/{session_id}/interact/voice-stream", tags=["语音"],
              response_class=StreamingResponse, responses={200: {
                  "description": "SSE：文字事件 + 按句 audio + speech_error + voice_done 耗时。",
                  "content": {"text/event-stream": {"schema": {"type": "string"}}}}})
    async def voice_interact(session_id: str, payload: InteractionInput, request: Request,
                             x_session_token: str = Header(default=""), db: Session = Depends(db_session),
                             audio_format: Literal["mp3", "pcm"] = Query(default="mp3")):
        current = app.state.settings
        prepared = prepare(request, db, session_id, x_session_token, payload)
        if not current.speech_enabled:
            raise HTTPException(422, "请先在后台的大模型接入页面配置并开启声音")

        async def events():
            source = execute_interaction(db, prepared, payload, current, request.state.request_id, model_transport, voice=True)
            async for event in stream_voice(source, current, speech_transport, audio_format=audio_format):
                yield "event: " + event["event"] + "\ndata: " + json.dumps(event["data"], ensure_ascii=False) + "\n\n"
        return StreamingResponse(events(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})

    @app.post(PREFIX + "/admin/login", tags=["管理登录"], response_model=Envelope[LoginOutput])
    def login(payload: LoginInput, request: Request):
        rate_limit(request, "admin-login", 10)
        if not check_password(settings, payload.username, payload.password):
            raise HTTPException(401, "用户名或密码不正确")
        return ok(request, {"access_token": signer(settings).dumps({"sub": settings.admin_username}),
                            "token_type": "bearer", "expires_in": 8 * 3600})

    admin = [Depends(require_admin)]

    @app.get(PREFIX + "/admin/model", dependencies=admin, tags=["大模型接入"], response_model=Envelope[ModelStatus])
    def read_model(request: Request):
        return ok(request, model_status(app.state))

    @app.put(PREFIX + "/admin/model", dependencies=admin, tags=["大模型接入"], response_model=Envelope[ModelStatus])
    def configure_model(payload: ModelConfigInput, request: Request):
        return ok(request, save_model_config(app.state, payload))

    @app.post(PREFIX + "/admin/model/test", dependencies=admin, tags=["大模型接入"], response_model=Envelope[ModelProbe])
    async def test_model(request: Request):
        rate_limit(request, "model-test", 5)
        current = app.state.settings
        if current.llm_mode != "live":
            raise HTTPException(422, "请先保存模型接口地址、模型名称和 API Key")
        started = monotonic()
        parts, usage = [], {}
        try:
            async for chunk in stream_model(current, [{"role": "user", "content": "请只回复：连接成功。"}], model_transport):
                if chunk.text:
                    parts.append(chunk.text)
                if chunk.usage:
                    usage.update(chunk.usage)
        except ModelUnavailable as exc:
            if app.state.settings is current:
                app.state.model_verification, app.state.model_last_error = "failed", exc.code
            return JSONResponse(status_code=503, content={"error": {"code": exc.code,
                "message": "连接测试失败，请检查模型信息、账号额度和网络", "request_id": request.state.request_id}})
        if app.state.settings is current:
            app.state.model_verification, app.state.model_last_error = "verified", None
        return ok(request, {"connected": True, "reply": "".join(parts)[:500],
                            "latency_ms": int((monotonic() - started) * 1000), "usage": usage})

    @app.get(PREFIX + "/admin/speech", dependencies=admin, tags=["语音"], response_model=Envelope[SpeechStatus])
    def read_speech(request: Request):
        return ok(request, speech_status(app.state))

    @app.put(PREFIX + "/admin/speech", dependencies=admin, tags=["语音"], response_model=Envelope[SpeechStatus])
    def configure_speech(payload: SpeechConfigInput, request: Request):
        return ok(request, save_speech_config(app.state, payload))

    @app.post(PREFIX + "/admin/speech/test", dependencies=admin, tags=["语音"], response_model=Envelope[SpeechProbe])
    async def test_speech(request: Request):
        rate_limit(request, "speech-test", 5)
        current = app.state.settings
        if not current.speech_enabled:
            raise HTTPException(422, "请先配置并开启声音")
        try:
            audio = await synthesize(current, "你好，欢迎来到非遗展馆。", speech_transport)
        except SpeechUnavailable as exc:
            return JSONResponse(status_code=503, content={"error": {
                "code": exc.code, "message": exc.message, "request_id": request.state.request_id}})
        return ok(request, audio.as_dict())


    @app.get(PREFIX + "/admin/items", dependencies=admin, tags=["管理"], response_model=Envelope[list[ItemAdmin]])
    def admin_items(request: Request, db: Session = Depends(db_session)):
        return ok(request, [item_dict(i, True) for i in db.scalars(select(HeritageItem).order_by(HeritageItem.id)).all()])

    @app.post(PREFIX + "/admin/items", dependencies=admin, status_code=201, tags=["管理"], response_model=Envelope[ItemAdmin])
    def add_item(payload: ItemInput, request: Request, db: Session = Depends(db_session)):
        if db.get(HeritageItem, payload.id):
            raise HTTPException(409, "物品编号已存在")
        try:
            value = save_item(db, payload)
        except IntegrityError:
            db.rollback()
            raise HTTPException(409, "物品编号已存在") from None
        return ok(request, item_dict(value, True))

    @app.put(PREFIX + "/admin/items/{item_id}", dependencies=admin, tags=["管理"], response_model=Envelope[ItemAdmin])
    def update_item(item_id: str, payload: ItemInput, request: Request, db: Session = Depends(db_session)):
        if item_id != payload.id:
            raise HTTPException(422, "物品编号不能在更新时改变")
        return ok(request, item_dict(save_item(db, payload, get_item(db, item_id, public=False)), True))






    # 放在最后：上面的接口和页面优先匹配，其余路径才交给网页静态文件。
    if (FRONTEND / "index.html").is_file():
        app.mount("/", FrontendFiles(directory=FRONTEND, html=True), name="chengyi-web")

    return app
