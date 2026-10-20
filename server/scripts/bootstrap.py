"""创建本地配置，不覆盖现有配置，也不输出密钥。"""
import os
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parents[1]
env = ROOT / ".env"
if not env.exists():
    password = secrets.token_urlsafe(18)
    config = (ROOT / ".env.example").read_text(encoding="utf-8")
    config = config.replace("ADMIN_PASSWORD=\n", "ADMIN_PASSWORD=" + password + "\n")
    config = config.replace("SECRET_KEY=\n", "SECRET_KEY=" + secrets.token_urlsafe(48) + "\n")
    # O_EXCL 避免并发初始化覆盖已经生成的凭证。
    with os.fdopen(os.open(env, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as handle:
        handle.write(config)
    credentials = ROOT / ".local-credentials.txt"
    with os.fdopen(os.open(credentials, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as handle:
        handle.write("非遗后台本地管理员\n用户名：admin\n密码：" + password + "\n\n仅供本机开发，请勿公开此文件。\n")
    print("本地配置已生成，管理员账号保存在 .local-credentials.txt。")
else:
    print("使用现有本地配置。")
