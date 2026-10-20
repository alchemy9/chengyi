"""生成承艺 Mac 免安装版（网页 + 后台 + 便携 Python），对方双击就能用，不用装 Python。

用法（在 server 目录）：.venv/bin/python scripts/build_mac_bundle.py [--refresh]
--refresh 会重新下载运行环境并重装依赖；默认复用 分享文件/_build 里已有的环境。
"""
import argparse
import hashlib
import secrets
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_share  # noqa: E402

ROOT = make_share.SERVER  # requirements、.env 都在 server/
PROJECT = make_share.ROOT
BUILD = ROOT / "分享文件" / "_build"
RUNTIME = BUILD / "runtime"
READY = RUNTIME / ".ready"
TOP = "承艺-Mac免安装版"
PRELOAD_PREFIXES = ("LLM_", "SPEECH_", "TTS_", "STT_")
KEY_NOTE = """已预置 AI Key
- 这个包已经带上发送者的 Dify 应用 Key 和语音 Key，打开就能用承艺 AI 和语音。
- 这个 Key 用的是发送者的额度，只给你自己使用，请不要把压缩包转发给别人。
- 后台账号在 server 文件夹的“后台账号.txt”里，可用于“模型和声音设置”。
"""
PY_VERSION = "3.12.15"
PBS_TAG = "20261013"
PY_URL = ("https://github.com/astral-sh/python-build-standalone/releases/download/"
          f"{PBS_TAG}/cpython-{PY_VERSION}%2B{PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz")
# 运行环境里用不到的部分，删掉可以少几十 MB。
TRIM = [
    "include", "share", "lib/tcl9", "lib/tcl9.0", "lib/tk9.0", "lib/itcl4.3.8",
    "lib/libtcl9.0.dylib", "lib/libtcl9tk9.0.dylib", "lib/libtk9.0.dylib",
    "lib/libpython3.12.dylib", "lib/python3.12/ensurepip",
    "lib/python3.12/config-3.12-darwin", "lib/python3.12/site-packages/pip",
    "lib/python3.12/site-packages/pytest", "lib/python3.12/site-packages/_pytest",
    "lib/python3.12/site-packages/pygments", "lib/python3.12/site-packages/pluggy",
    "lib/python3.12/site-packages/iniconfig", "bin/pytest", "bin/pygmentize",
    "bin/idle3", "bin/idle3.12", "bin/2to3", "bin/2to3-3.12",
]
INTRO = """承艺 · Mac 免安装版

怎么打开
1. 先把压缩包完整解压到一个普通文件夹，不要在压缩包里直接双击运行。
2. 双击“start.command”。这台电脑不需要安装 Python，运行环境已经在 server 文件夹里。
3. 第一次打开如果提示“无法验证开发者”，在文件上点右键选“打开”，或在“系统设置 → 隐私与安全性”里点“仍要打开”。
4. 启动窗口显示出“承艺”网址后，浏览器会自动打开；没自动打开就复制网址到 Chrome 或 Edge。
5. 保持启动窗口打开。关闭时，在启动窗口按 Ctrl+C。

电脑要求
- Apple 芯片 Mac（M1/M2/M3/M4 等）。Intel 芯片的 Mac 打不开这个版本，需要用另一份带 Python 的分享版。
- 第一次启动会生成数据库和后台账号，账号保存在 server 文件夹的“后台账号.txt”。

先试什么
从序章一路走到陶瓷篇章，末尾进入工作台：择土、练泥、成形、施釉、入窑。
底部的承艺 AI 可以输入“做个爱心碗”“瓶口收一点”“施天青釉配缠枝莲”，也可以按住话筒说话；需要先在“模型和声音设置”（网址后加 /admin）里填 Dify 和硅基流动的 Key。
没有 Key 时，手动操作和常用指令仍可用。

本压缩包未放入发送者的 API Key、管理员密码、数据库、录音和个人数据。
"""


def log(message):
    print(message, flush=True)


def download(url, target):
    log("正在下载 Mac 运行环境（约 24 MB）……")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=120) as response, target.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def prepare_runtime(refresh):
    if refresh and RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    if READY.exists():
        log("复用已准备好的运行环境。")
        return
    BUILD.mkdir(parents=True, exist_ok=True)
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    archive = BUILD / "python.tar.gz"
    if not archive.exists():
        download(PY_URL, archive)
    log("正在解压运行环境……")
    with tarfile.open(archive) as tar:
        tar.extractall(BUILD)
    (BUILD / "python").rename(RUNTIME)
    log("正在精简运行环境……")
    for item in TRIM:
        path = RUNTIME / item
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    log("正在安装依赖到运行环境（首次需要联网）……")
    subprocess.run([str(RUNTIME / "bin" / "python3"), "-m", "pip", "install",
                    "--no-warn-script-location", "-r", str(ROOT / "requirements.txt")],
                   cwd=ROOT, check=True)
    READY.write_text(PY_VERSION, encoding="utf-8")


def copy_tree(source, target):
    shutil.copytree(source, target, symlinks=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))


def read_env(path):
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def make_env(with_keys):
    """按 .env.example 生成一份新配置；with_keys 时把本机的模型和语音 Key 填进去。"""
    template = (ROOT / ".env.example").read_text(encoding="utf-8")
    source = read_env(ROOT / ".env") if with_keys else {}
    password = secrets.token_urlsafe(18)
    lines = []
    for line in template.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            lines.append(line)
            continue
        key = stripped.partition("=")[0].strip()
        if key == "ADMIN_PASSWORD":
            value = password
        elif key == "SECRET_KEY":
            value = secrets.token_urlsafe(48)
        elif with_keys and key.startswith(PRELOAD_PREFIXES) and source.get(key):
            value = source[key]
        else:
            value = stripped.partition("=")[2]
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n", password


def assemble(with_keys=False):
    stage = BUILD / "stage"
    if stage.exists():
        shutil.rmtree(stage)
    top = stage / TOP
    top.mkdir(parents=True)
    for path in make_share.collect():
        if path.name == ".env.example":
            continue  # 免安装版用自己单独的配置
        target = top / path.relative_to(PROJECT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    server = top / "server"
    copy_tree(RUNTIME, server / "runtime" / "python")
    env_text, password = make_env(with_keys)
    with (server / ".env").open("w", encoding="utf-8") as handle:
        handle.write(env_text)
    (server / ".env").chmod(0o600)
    (server / "后台账号.txt").write_text(
        "承艺后台本地管理员\n用户名：admin\n密码：" + password + "\n", encoding="utf-8")
    (server / "后台账号.txt").chmod(0o600)
    intro = INTRO
    if with_keys:
        intro = intro.replace(
            "本压缩包未放入发送者的 API Key、管理员密码、数据库、录音和个人数据。",
            KEY_NOTE.strip())
    (top / "使用方法.txt").write_text(intro, encoding="utf-8")
    return top


def pack(top, with_keys=False):
    suffix = "-含Key" if with_keys else ""
    target = ROOT / "分享文件" / time.strftime(f"承艺-Mac免安装版{suffix}-%Y%m%d.zip")
    log("正在压缩（运行环境较大，需要一点时间）……")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(top.rglob("*")):
            if path.is_dir():
                continue  # 目录不写条目，解压时自动创建
            relative = path.relative_to(top).as_posix()
            info = zipfile.ZipInfo(TOP + "/" + relative)
            info.date_time = time.localtime()[:6]
            executable = path.name.endswith((".command", ".sh")) or (
                path.parent.name == "bin" and path.is_file())
            private = path.name in (".env", "后台账号.txt", ".local-credentials.txt")
            mode = 0o755 if executable else (0o600 if private else 0o644)
            info.external_attr = (0o100000 | mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            if path.is_symlink():
                info.external_attr = (0o120777) << 16
            archive.writestr(info, path.read_bytes() if path.is_file() else b"")
    return target


def check(target, with_keys=False):
    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
    allowed = set(make_share.FORBIDDEN_NAMES)
    if with_keys:
        allowed -= {".env", "后台账号.txt"}
    leaked = [name for name in names
              if Path(name).name in allowed
              or name.endswith(make_share.FORBIDDEN_SUFFIXES)
              or "/data/" in name or "/.venv/" in name]
    if leaked:
        target.unlink()
        raise SystemExit("压缩包里有不该出现的文件，已删除：" + "，".join(leaked))
    if not any(Path(name).name.startswith("python3") and "/server/runtime/python/bin/" in name
               for name in names):
        target.unlink()
        raise SystemExit("压缩包里缺少运行环境。")
    log("检查通过：%d 个文件，%.1f MB" % (len(names), target.stat().st_size / 1024 / 1024))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--with-keys", action="store_true",
                        help="把本机 .env 里的 Dify 和语音 Key 预置进包（只给可信的人）")
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("免安装版要在 Mac 上打包。")
    prepare_runtime(args.refresh)
    top = assemble(args.with_keys)
    target = pack(top, args.with_keys)
    check(target, args.with_keys)
    log("免安装版已生成：" + str(target))
    return 0


if __name__ == "__main__":
    sys.exit(main())
