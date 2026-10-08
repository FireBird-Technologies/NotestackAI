from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


_sqlite = settings.database_url.startswith("sqlite")
# Postgres: a connection that dies silently (laptop sleep, network change, Neon dropping it) otherwise leaves a query
# waiting on the socket forever, and the worker loop with it. Keepalives notice a dead peer within about a minute
# and the query fails instead; connect_timeout does the same for a connect that never completes.
_pg_connect_args = {"connect_timeout": 10, "keepalives": 1, "keepalives_idle": 30, "keepalives_interval": 10,
                    "keepalives_count": 3}
_connect_args = {"check_same_thread": False, "timeout": 30} if _sqlite else _pg_connect_args
engine = create_engine(settings.database_url, pool_pre_ping=True, pool_recycle=300, connect_args=_connect_args)

if _sqlite:
    # Local dev: the API and the worker share one file. WAL lets reads run during a write, the busy
    # timeout makes a second writer wait instead of failing, and SQLite needs FKs switched on.
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
