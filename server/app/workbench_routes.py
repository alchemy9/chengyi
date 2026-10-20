import json
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Request
from fastapi.responses import RedirectResponse, StreamingResponse
from sqlalchemy.orm import Session

from app import workbench as service
from app.voice_stream import stream_voice
from app.workbench_schemas import CreateWorkbench, SyncWorkbench, WorkbenchRequest, ToolRequest, WorkbenchReceipt, SpeakRequest


def install(app, static, db_session, ok, rate_limit):
    # 工作台已并入承艺网页；旧地址转到网页里的工作台场景。
    @app.get("/workbench", include_in_schema=False)
    @app.get("/workbench/", include_in_schema=False)
    def old_workbench():
        return RedirectResponse("/#workbench")

    base = "/api/v1/workbenches"

    @app.get(base + "/tools/openapi.json", tags=["陶艺工作台"])
    def tools_schema():
        return service.openapi_tools()

    @app.post(base, status_code=201, tags=["陶艺工作台"])
    def create(payload: CreateWorkbench, request: Request, db: Session = Depends(db_session)):
        rate_limit(request, "new-workbench", 20)
        return ok(request, service.create(db, payload, app.state.settings))

    @app.get(base + "/{project_id}", tags=["陶艺工作台"])
    def read(project_id: UUID, request: Request, x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        return ok(request, service.current(db, service.authenticate(db, str(project_id), x_session_token)))

    @app.post(base + "/{project_id}/sync", tags=["陶艺工作台"])
    def sync(project_id: UUID, payload: SyncWorkbench, request: Request, x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        rate_limit(request, "workbench-sync", 180)
        return ok(request, service.sync(db, service.authenticate(db, str(project_id), x_session_token), payload))

    @app.post(base + "/{project_id}/cancel", tags=["陶艺工作台"])
    def cancel(project_id: UUID, request: Request, x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        rate_limit(request, "workbench-cancel", 120)
        return ok(request, service.cancel(db, service.authenticate(db, str(project_id), x_session_token)))

    @app.post(base + "/{project_id}/commands", tags=["陶艺工作台"])
    async def command(project_id: UUID, payload: WorkbenchRequest, request: Request,
                      x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        rate_limit(request, "workbench-command", 60)
        project = service.authenticate(db, str(project_id), x_session_token)
        return ok(request, await service.plan(db, project, payload, app.state, request.state.request_id))

    @app.post(base + "/{project_id}/tools/{tool_name}", tags=["陶艺工作台"])
    def tool(project_id: UUID, tool_name: str, payload: ToolRequest, request: Request,
             x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        rate_limit(request, "workbench-tool", 90)
        return ok(request, service.tool(db, service.authenticate(db, str(project_id), x_session_token), tool_name, payload))

    @app.post(base + "/{project_id}/commands/{command_id}/receipt", tags=["陶艺工作台"])
    def receipt(project_id: UUID, command_id: UUID, payload: WorkbenchReceipt, request: Request,
                x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        return ok(request, service.receive(db, service.authenticate(db, str(project_id), x_session_token), command_id, payload))

    @app.post(base + "/{project_id}/speech", tags=["陶艺工作台"])
    def speak(project_id: UUID, payload: SpeakRequest, request: Request,
              x_session_token: str = Header(default=""), db: Session = Depends(db_session)):
        rate_limit(request, "workbench-speech", 40)
        project = service.authenticate(db, str(project_id), x_session_token)
        text = service.speech_text(db, project, payload.command_id)
        current = app.state.settings
        if not current.speech_enabled:
            raise HTTPException(422, "后台尚未开启声音")

        async def source():
            yield {"event": "delta", "data": {"text": text}}
            yield {"event": "result", "data": {"text": text}}

        async def events():
            async for event in stream_voice(source(), current, app.state.speech_transport, audio_format="pcm"):
                yield "event: " + event["event"] + "\ndata: " + json.dumps(event["data"], ensure_ascii=False) + "\n\n"
        return StreamingResponse(events(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})
