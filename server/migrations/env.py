from alembic import context
from sqlalchemy import create_engine

from app.config import Settings
from app.db import Base
import app.models  # noqa: F401

target_metadata = Base.metadata
settings = Settings()


def offline():
    context.configure(url=settings.database_url, target_metadata=target_metadata,
                      literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def online():
    from sqlalchemy.engine import make_url
    from pathlib import Path
    parsed = make_url(settings.database_url)
    if parsed.get_backend_name() == "sqlite" and parsed.database and parsed.database != ":memory:":
        Path(parsed.database).parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(settings.database_url)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    offline()
else:
    online()
