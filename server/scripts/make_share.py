"""生成可转发的分享版压缩包（网页 + 后台）；只收白名单文件，绝不包含密钥、数据库和个人数据。"""
import datetime
import os
from pathlib import Path
import sys
import zipfile

SERVER = Path(__file__).resolve().parents[1]
ROOT = SERVER.parent  # 承艺项目根目录：网页在这里，后台在 server/
OUT_DIR = SERVER / "分享文件"
TOP = "承艺-分享版"

# 目录整体收录；data、.venv、runtime 等一律不收。
INCLUDE_DIRS = ["css", "js", "assets", "tests", "server/app", "server/migrations", "server/scripts",
                "server/docs", "server/tests"]
INCLUDE_FILES = [
    "index.html",
    "README.md",
    "start.command",
    "启动承艺-Windows.bat",
    "tools/serve.py",
    "server/.env.example",
    "server/requirements.txt",
    "server/alembic.ini",
    "server/pyproject.toml",
]
# 收进目录但必须跳过的文件。
SKIP_NAMES = {"__pycache__", ".pytest_cache", ".DS_Store", "data", ".venv", "runtime",
              "后台账号.txt", ".env", ".local-credentials.txt"}
SKIP_PATTERNS = (".pyc", ".log", ".model-config-")
# 分享包里绝不应出现的文件：密钥、账号、数据库、录音。
FORBIDDEN_SUFFIXES = (".db", ".sqlite3", ".mp3", ".wav", ".m4a")
FORBIDDEN_NAMES = {".env", ".local-credentials.txt", "后台账号.txt"}


def wanted(path: Path):
    name = path.name
    if name in SKIP_NAMES:
        return False
    if name.endswith(SKIP_PATTERNS):
        return False
    return True


def collect():
    entries = []
    for directory in INCLUDE_DIRS:
        base = ROOT / directory
        for root, dirs, files in os.walk(base):
            dirs[:] = [item for item in dirs if item not in SKIP_NAMES]
            for item in files:
                path = Path(root) / item
                if wanted(path):
                    entries.append(path)
    for item in INCLUDE_FILES:
        path = ROOT / item
        if not path.is_file():
            raise SystemExit("缺少必要文件：" + item)
        entries.append(path)
    return sorted(entries)


def add_entry(archive: zipfile.ZipFile, path: Path):
    info = zipfile.ZipInfo(TOP + "/" + path.relative_to(ROOT).as_posix())
    info.date_time = datetime.datetime.now().timetuple()[:6]
    mode = 0o755 if path.suffix in (".command", ".bat") else 0o644
    info.external_attr = (0o100000 | mode) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, path.read_bytes())


def main():
    entries = collect()
    OUT_DIR.mkdir(exist_ok=True)
    stamp = datetime.date.today().strftime("%Y%m%d")
    target = OUT_DIR / f"承艺-分享版-{stamp}.zip"
    with zipfile.ZipFile(target, "w") as archive:
        for path in entries:
            add_entry(archive, path)
    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
    leaked = [name for name in names
              if Path(name).name in FORBIDDEN_NAMES or name.endswith(FORBIDDEN_SUFFIXES)
              or "/data/" in name or "/.venv/" in name or "/runtime/" in name]
    if leaked:
        target.unlink()
        raise SystemExit("分享包里有不该出现的文件，已删除：" + "，".join(leaked))
    print("分享包已生成：" + str(target))
    print("文件数：" + str(len(names)))
    print("大小：%.1f MB" % (target.stat().st_size / 1024 / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
