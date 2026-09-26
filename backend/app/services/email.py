"""EmailService over a provider interface (Resend in prod, console locally).

Rule: no em dashes in any copy. Broadcast bodies are plain text and get HTML escaped.
"""

import hashlib
import hmac
import html
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.config import settings

log = logging.getLogger(__name__)


@dataclass
class OutgoingEmail:
    to: str
    subject: str
    html: str
    text: str
    headers: dict[str, str] | None = None


class BaseEmailProvider(ABC):
    @abstractmethod
    def send(self, email: OutgoingEmail) -> str | None: ...


class ResendEmailProvider(BaseEmailProvider):
    def __init__(self, api_key: str):
        import resend

        resend.api_key = api_key
        self._resend = resend

    def send(self, email: OutgoingEmail) -> str | None:
        params = {
            "from": settings.from_email,
            "to": [email.to],
            "subject": email.subject,
            "html": email.html,
            "text": email.text,
        }
        if email.headers:
            params["headers"] = email.headers
        result = self._resend.Emails.send(params)
        return result.get("id") if isinstance(result, dict) else None


class ConsoleEmailProvider(BaseEmailProvider):
    sent: list[OutgoingEmail] = []

    def send(self, email: OutgoingEmail) -> str | None:
        ConsoleEmailProvider.sent.append(email)
        log.info("[email] to=%s subject=%s\n%s", email.to, email.subject, email.text)
        return None


def make_unsubscribe_token(user_id: str) -> str:
    sig = hmac.new(settings.unsubscribe_secret.encode(), user_id.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{user_id}.{sig}"


def verify_unsubscribe_token(token: str) -> str | None:
    user_id, _, _sig = token.partition(".")
    if user_id and hmac.compare_digest(make_unsubscribe_token(user_id), token):
        return user_id
    return None


def _layout(title: str, body_html: str, footer_html: str = "") -> str:
    # Inline styles only; email clients ignore <style>. Black, #217cff, white.
    return f"""<!doctype html><html><body style="margin:0;background:#000000;padding:32px 16px;
font-family:Inter,Arial,sans-serif;color:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;
border:1px solid rgba(33,124,255,0.35);border-radius:16px;padding:32px;background:#000000">
<tr><td style="font-size:13px;letter-spacing:0.2em;text-transform:uppercase;color:#217cff">Notestack</td></tr>
<tr><td style="padding-top:16px;font-size:22px;font-weight:600;color:#ffffff">{html.escape(title)}</td></tr>
<tr><td style="padding-top:16px;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.85)">{body_html}</td></tr>
<tr><td style="padding-top:28px;font-size:12px;color:rgba(255,255,255,0.5)">{footer_html}</td></tr>
</table></td></tr></table></body></html>"""


def _button(label: str, url: str) -> str:
    return (
        f'<p style="padding-top:12px"><a href="{html.escape(url)}" style="display:inline-block;'
        f"background:#217cff;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:999px;"
        f'font-weight:600">{html.escape(label)}</a></p>'
    )


def _code_block(code: str) -> str:
    return (
        f'<p style="font-family:JetBrains Mono,monospace;font-size:32px;letter-spacing:0.3em;'
        f'color:#ffffff;padding:8px 0">{html.escape(code)}</p>'
    )


class EmailService:
    def __init__(self, provider: BaseEmailProvider):
        self.provider = provider

    def _send(self, email: OutgoingEmail) -> bool:
        try:
            self.provider.send(email)
            return True
        except Exception:  # never let email failures break the request
            log.exception("email send failed to=%s subject=%s", email.to, email.subject)
            return False

    # Transactional

    def send_verification_code(self, to: str, code: str) -> bool:
        body = f"Enter this code to finish creating your account:{_code_block(code)}It expires in 10 minutes."
        return self._send(
            OutgoingEmail(
                to=to,
                subject=f"{code} is your Notestack code",
                html=_layout("Confirm your email", body, "If you did not sign up, ignore this email."),
                text=f"Your Notestack code is {code}. It expires in 10 minutes.",
            )
        )

    def send_password_reset_code(self, to: str, code: str) -> bool:
        body = f"Use this code to reset your password:{_code_block(code)}It expires in 10 minutes."
        return self._send(
            OutgoingEmail(
                to=to,
                subject="Reset your Notestack password",
                html=_layout("Password reset", body, "If you did not ask for this, you can ignore it."),
                text=f"Your Notestack password reset code is {code}. It expires in 10 minutes.",
            )
        )

    def send_welcome(self, to: str, name: str | None, user_id: str) -> bool:
        first = (name or "there").split(" ")[0]
        url = f"{settings.frontend_url}/app"
        body = (
            f"Hi {html.escape(first)},<br><br>Your archive is about to come into orbit. Paste your Substack "
            "URL and Notestack will index your posts, learn your voice and get your first audio overview ready."
            + _button("Open Mission Control", url)
        )
        return self._send(
            OutgoingEmail(
                to=to,
                subject="Welcome to Notestack",
                html=_layout("Welcome aboard", body, self._unsubscribe_footer(user_id)),
                text=f"Hi {first}, welcome to Notestack. Open Mission Control: {url}",
                headers=self._list_unsubscribe(user_id),
            )
        )

    def send_job_ready(self, to: str, what: str, url: str) -> bool:
        body = f"Your {html.escape(what)} is ready." + _button("View it", url)
        return self._send(
            OutgoingEmail(
                to=to,
                subject=f"Your {what} is ready",
                html=_layout("Launch complete", body),
                text=f"Your {what} is ready: {url}",
            )
        )

    def send_post_reminder(self, to: str, platform: str, content: str, url: str) -> bool:
        body = (
            f"Your {html.escape(platform)} post is scheduled for now. Copy it below and post it."
            f"<pre style='white-space:pre-wrap;background:rgba(255,255,255,0.06);padding:16px;border-radius:8px'>"
            f"{html.escape(content)}</pre>" + _button("Open Launchpad", url)
        )
        return self._send(
            OutgoingEmail(
                to=to,
                subject=f"Time to post on {platform}",
                html=_layout("Launch window open", body),
                text=f"Time to post on {platform}:\n\n{content}\n\nLaunchpad: {url}",
            )
        )

    # Internal alerts

    def send_alert(self, subject: str, text: str) -> bool:
        return self._send(
            OutgoingEmail(
                to=settings.alerts_email,
                subject=f"[Notestack alert] {subject}",
                html=_layout(subject, f"<pre style='white-space:pre-wrap'>{html.escape(text)}</pre>"),
                text=text,
            )
        )

    # Broadcast

    def send_blast_email(self, user_id: str, user_email: str, user_name: str | None, subject: str, body: str) -> bool:
        first = (user_name or "there").split(" ")[0]
        body_html = f"Hi {html.escape(first)},<br><br>" + html.escape(body).replace("\n", "<br>")
        return self._send(
            OutgoingEmail(
                to=user_email,
                subject=subject,
                html=_layout(subject, body_html, self._unsubscribe_footer(user_id)),
                text=f"Hi {first},\n\n{body}\n\nUnsubscribe: {self._unsubscribe_url(user_id)}",
                headers=self._list_unsubscribe(user_id),
            )
        )

    def _unsubscribe_url(self, user_id: str) -> str:
        return f"{settings.api_url}/api/unsubscribe?token={make_unsubscribe_token(user_id)}"

    def _unsubscribe_footer(self, user_id: str) -> str:
        return f'<a href="{self._unsubscribe_url(user_id)}" style="color:rgba(255,255,255,0.5)">Unsubscribe</a>'

    def _list_unsubscribe(self, user_id: str) -> dict[str, str]:
        return {
            "List-Unsubscribe": f"<{self._unsubscribe_url(user_id)}>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }


def _build() -> EmailService:
    if settings.email_provider == "resend" and settings.resend_api_key:
        return EmailService(ResendEmailProvider(settings.resend_api_key))
    return EmailService(ConsoleEmailProvider())


email_service = _build()
