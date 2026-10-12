from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


_sqlite = settings.database_url.startswith("sqlite")
# A hosted Postgres (Neon) closes idle connections and drops the odd one on a network blip, and a connection that dies silently
# (laptop sleep, network change) otherwise leaves a query waiting on the socket forever, and the worker loop with it. TCP
# keepalives notice a dead peer within about a minute, so the query fails instead and a dead socket is noticed while it sits in
# the pool; connect_timeout does the same for a connect that never completes. A pooled connection is also replaced before it
# is handed out (pool_recycle, below Neon's idle timeout), since pool_pre_ping alone can fail on a dead SSL socket with a
# ProgrammingError ("can't change 'autocommit' now") that SQLAlchemy does not treat as a lost connection, and the request
# ends in a 500.
_pg_connect_args = {"connect_timeout": 10, "keepalives": 1, "keepalives_idle": 30, "keepalives_interval": 10,
                    "keepalives_count": 3}
_connect_args = {"check_same_thread": False, "timeout": 30} if _sqlite else _pg_connect_args
engine = create_engine(settings.database_url, pool_pre_ping=True, connect_args=_connect_args,
                       **({} if _sqlite else {"pool_recycle": 240, "pool_use_lifo": True}))

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
