import hashlib
import secrets
from collections import OrderedDict, deque
from threading import Lock
from time import monotonic

from fastapi import HTTPException, Request
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer


def hash_token(token: str):
    return hashlib.sha256(token.encode()).hexdigest()


def signer(settings):
    # 密码变更也会使旧管理员令牌失效。
    salt = "heritage-admin:" + hash_token(settings.admin_password.get_secret_value())
    return URLSafeTimedSerializer(settings.secret_key.get_secret_value(), salt=salt)


def require_admin(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "请先登录管理后台")
    try:
        data = signer(request.app.state.settings).loads(auth[7:], max_age=8 * 3600)
        if data.get("sub") != request.app.state.settings.admin_username:
            raise BadSignature("invalid subject")
    except (BadSignature, SignatureExpired, AttributeError):
        raise HTTPException(401, "登录已失效，请重新登录") from None


class RateLimiter:
    """单进程的有界滑动窗口；多进程部署时应换成共享限流存储。"""
    def __init__(self):
        self.entries = OrderedDict()
        self.lock = Lock()

    def check(self, key: str, limit: int, seconds: int = 60):
        now = monotonic()
        with self.lock:
            queue = self.entries.setdefault(key, deque())
            self.entries.move_to_end(key)
            while queue and queue[0] <= now - seconds:
                queue.popleft()
            if len(queue) >= limit:
                raise HTTPException(429, "操作太频繁，请稍后再试", headers={"Retry-After": str(seconds)})
            queue.append(now)
            while len(self.entries) > 10000:
                self.entries.popitem(last=False)


def check_password(settings, username: str, password: str):
    user_ok = secrets.compare_digest(username.encode(), settings.admin_username.encode())
    pass_ok = secrets.compare_digest(password.encode(), settings.admin_password.get_secret_value().encode())
    return user_ok and pass_ok
