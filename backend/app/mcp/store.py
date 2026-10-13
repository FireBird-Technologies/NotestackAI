import contextlib
import logging

from anyio import to_thread
from sqlalchemy.orm import Session

from app import db as database

log = logging.getLogger(__name__)


def open_session() -> Session:
    return database.SessionLocal()


@contextlib.contextmanager
def session():
    db = open_session()
    try:
        yield db
    finally:
        db.close()


async def run(fn, *args):
    """Run blocking database work off the event loop, in its own session (committed by fn if it writes)."""

    def work():
        with session() as db:
            return fn(db, *args)

    return await to_thread.run_sync(work)
