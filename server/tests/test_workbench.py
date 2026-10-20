"""工作台接口：施釉工具、玉壶春器形、整站托管时不泄露后端文件。"""
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Base
from app.main import create_app
from app.pottery import profile


@pytest.fixture()
def client(tmp_path):
    settings = Settings(_env_file=None, admin_password="x" * 16, secret_key="y" * 40,
                        database_url="sqlite:///" + str(tmp_path / "t.db"), llm_mode="demo")
    app = create_app(settings, configuration_path=tmp_path / ".env")
    Base.metadata.create_all(app.state.engine)
    with TestClient(app) as c:
        yield c


def document(**extra):
    return {"name": "测试", "profile": profile("vase"), "height": 28, "material": "terracotta",
            "gloss": 25, "preset": "vase", **extra}


def create(client, **extra):
    body = client.post("/api/v1/workbenches", json={"document": document(**extra)}).json()["data"]
    return body["project"], {"X-Session-Token": body["session_token"]}


def run_tool(client, project, headers, name, arguments):
    data = client.post(f"/api/v1/workbenches/{project['id']}/tools/{name}", headers=headers, json={
        "expected_revision": project["revision"], "client_request_id": str(uuid4()), "arguments": arguments}).json()["data"]
    command = data["command"]
    receipt = client.post(f"/api/v1/workbenches/{project['id']}/commands/{command['id']}/receipt", headers=headers, json={
        "expected_revision": command["revision"], "status": "applied", "document": command["document"]})
    assert receipt.status_code == 200, receipt.text
    return command, receipt.json()["data"]["project"]


def test_new_document_defaults_to_unglazed(client):
    project, _ = create(client)
    assert project["document"]["glaze"] == "none"
    assert project["document"]["pattern"] == "plain"
    assert project["document"]["view"]["azimuth_deg"] == 0


def test_set_glaze_tool(client):
    project, headers = create(client)
    command, project = run_tool(client, project, headers, "set_glaze",
                                {"glaze": "tianqing", "pattern": "lotus", "ink": "copper", "crackle": True})
    doc = project["document"]
    assert (doc["glaze"], doc["pattern"], doc["ink"], doc["crackle"]) == ("tianqing", "lotus", "copper", True)
    assert "天青釉" in command["message"] and "缠枝莲" in command["message"]
    assert project["undo_count"] == 1


def test_unglazed_clears_crackle(client):
    project, headers = create(client, glaze="fenqing", crackle=True)
    _, project = run_tool(client, project, headers, "set_glaze", {"glaze": "none"})
    assert project["document"]["crackle"] is False


def test_legacy_glaze_material_becomes_glaze(client):
    project, headers = create(client)
    _, project = run_tool(client, project, headers, "set_material", {"material": "celadon"})
    assert project["document"]["material"] == "cream"
    assert project["document"]["glaze"] == "fenqing"


def test_yuhuchun_preset(client):
    project, headers = create(client)
    _, project = run_tool(client, project, headers, "set_base_shape", {"shape": "yuhuchun"})
    assert project["document"]["height"] == 30
    assert project["measurements"]["base_shape_name"] == "玉壶春瓶"


def test_local_glaze_command_needs_no_model(client):
    project, headers = create(client)
    data = client.post(f"/api/v1/workbenches/{project['id']}/commands", headers=headers, json={
        "expected_revision": project["revision"], "client_request_id": str(uuid4()), "text": "施天青釉"}).json()["data"]
    assert data["command"]["actions"] == [{"tool": "set_glaze", "arguments": {"glaze": "tianqing"}}]


def test_site_is_served_but_server_files_are_not(client):
    assert client.get("/").status_code == 200
    assert "承艺" in client.get("/").text
    assert client.get("/js/main.js").status_code == 200
    assert client.get("/admin").status_code == 200
    for path in ("/server/.env", "/server/app/main.py", "/tools/serve.py", "/README.md", "/.gitignore"):
        assert client.get(path).status_code == 404, path
    assert client.get("/workbench/", follow_redirects=False).headers["location"] == "/#workbench"
