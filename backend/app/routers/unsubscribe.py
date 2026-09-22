import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.services.email import verify_unsubscribe_token

router = APIRouter(prefix="/api", tags=["email"])

_PAGE = """<!doctype html><html><body style="background:#000;color:#fff;font-family:Inter,Arial,sans-serif;
display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:16px">
<p style="color:#217cff;letter-spacing:.2em;text-transform:uppercase;font-size:13px">Notestack</p>
<h1 style="font-weight:600">{title}</h1><p style="color:rgba(255,255,255,.7)">{body}</p></div></body></html>"""


def _apply(token: str, db: Session) -> bool:
    user_id = verify_unsubscribe_token(token)
    if not user_id:
        return False
    try:
        user = db.get(User, uuid.UUID(user_id))
    except ValueError:
        return False
    if not user:
        return False
    user.email_unsubscribed = True
    db.commit()
    return True


@router.get("/unsubscribe", response_class=HTMLResponse)
def unsubscribe(token: str, db: Session = Depends(get_db)):
    if _apply(token, db):
        return _PAGE.format(title="You are unsubscribed", body="You will still get account and security emails.")
    return HTMLResponse(_PAGE.format(title="Link not valid", body="This unsubscribe link is invalid."), 400)


@router.post("/unsubscribe")
def unsubscribe_one_click(token: str, db: Session = Depends(get_db)):
    """RFC 8058 one click (List-Unsubscribe-Post)."""
    return {"ok": _apply(token, db)}
