"""Start the local development server independently of this chat's terminal."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    try:
        with socket.create_connection(("127.0.0.1", 8000), timeout=.5):
            pass
    except OSError:
        pass
    else:
        print("8000 端口已在使用；请检查已有后台，无需重复启动。")
        return
    directory = ROOT / "data"
    directory.mkdir(exist_ok=True)
    log_path = directory / "backend.log"
    with log_path.open("ab") as log:
        os.chmod(log_path, 0o600)
        process = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:create_app",
            "--factory", "--host", "127.0.0.1", "--port", "8000"], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (directory / "backend.pid").write_text(str(process.pid))
    for _ in range(20):
        if process.poll() is not None:
            raise SystemExit("后台没有启动，请检查 data/backend.log。")
        try:
            response = httpx.get("http://127.0.0.1:8000/health", timeout=.5)
            if response.status_code == 200 and response.json()["data"]["status"] == "ok":
                print("后台已独立运行：http://127.0.0.1:8000/")
                return
        except (httpx.HTTPError, ValueError, KeyError):
            pass
        time.sleep(.25)
    raise SystemExit("后台正在启动，请稍后查看本机页面或 data/backend.log。")


if __name__ == "__main__":
    main()
