"""Prepare and run a recipient's local copy, using only Python's standard library."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[1]


def run(command):
    subprocess.run(command, cwd=ROOT, check=True)


def bundled_python():
    """压缩包自带运行环境时的 Python 路径；没有就返回 None。"""
    for relative in ("runtime/python/bin/python3", "runtime/python/bin/python3.12",
                     "runtime/python/python.exe"):
        candidate = ROOT / relative
        if candidate.is_file():
            return candidate
    return None


def running_bundled(python):
    try:
        return Path(sys.executable).resolve() == python.resolve()
    except OSError:
        return False


def prepare():
    bundled = bundled_python()
    if bundled is not None and running_bundled(bundled):
        # 自带运行环境：依赖已经装好，不再联网安装。
        python = bundled
    else:
        python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not python.is_file():
            print("首次启动，正在创建运行环境……", flush=True)
            run([sys.executable, "-m", "venv", str(ROOT / ".venv")])
        fingerprint = hashlib.sha256((ROOT / "requirements.txt").read_bytes()).hexdigest()
        marker = ROOT / ".venv" / ".share-requirements"
        if not marker.exists() or marker.read_text(encoding="utf-8").strip() != fingerprint:
            print("正在安装运行所需文件，首次启动需要联网，请等待安装完成。", flush=True)
            run([str(python), "-m", "pip", "install", "-r", "requirements.txt"])
            marker.write_text(fingerprint, encoding="utf-8")
    run([str(python), "scripts/bootstrap.py"])
    run([str(python), "-m", "alembic", "upgrade", "head"])
    credentials = ROOT / ".local-credentials.txt"
    visible_credentials = ROOT / "后台账号.txt"
    if credentials.exists() and not visible_credentials.exists():
        with visible_credentials.open("x", encoding="utf-8") as handle:
            handle.write(credentials.read_text(encoding="utf-8"))
        visible_credentials.chmod(0o600)
    return python


def available_port(first):
    for port in range(first, min(first + 10, 65536)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            try:
                connection.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("附近的端口都已被占用，请关闭以前启动的承艺窗口，再重新启动。")


def serve(python, port, open_browser=True):
    port = available_port(port)
    url = "http://127.0.0.1:" + str(port)
    process = subprocess.Popen([str(python), "-m", "uvicorn", "app.main:create_app", "--factory",
                                "--host", "127.0.0.1", "--port", str(port)], cwd=ROOT)
    # Do not use HTTP proxy settings to check a service on this computer.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        ready = False
        for _ in range(80):
            if process.poll() is not None:
                raise RuntimeError("承艺后台未能启动，请查看窗口中的错误信息。")
            try:
                with opener.open(url + "/health", timeout=.5) as response:
                    ready = json.load(response).get("data", {}).get("status") == "ok"
            except (OSError, ValueError):
                pass
            if ready:
                break
            time.sleep(.25)
        if not ready:
            raise RuntimeError("承艺后台启动超时，请查看窗口中的错误信息。")
        print("\n承艺：" + url + "/", flush=True)
        print("直接进工作台：" + url + "/#workbench", flush=True)
        print("模型和声音设置：" + url + "/admin", flush=True)
        print("后台登录账号保存在 server 文件夹的“后台账号.txt”。", flush=True)
        print("请保持这个窗口打开。关闭时，在这里按 Ctrl+C。\n", flush=True)
        if open_browser:
            try:
                webbrowser.open(url + "/")
            except webbrowser.Error:
                print("请将上面的地址复制到浏览器打开。", flush=True)
        return process.wait()
    except KeyboardInterrupt:
        print("\n正在关闭……", flush=True)
        return 0
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if sys.version_info < (3, 12):
        print("请先安装 Python 3.12 或更新版本，再重新打开启动文件。")
        return 1
    os.environ["PYTHONUTF8"] = "1"
    os.chdir(ROOT)
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("端口应在 1024 到 65535 之间。")
    try:
        python = prepare()
        return 0 if args.prepare_only else serve(python, args.port, not args.no_browser)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print("\n启动没有完成：" + str(error), flush=True)
        print("如果安装文件失败，请检查网络后重新打开启动文件。", flush=True)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
