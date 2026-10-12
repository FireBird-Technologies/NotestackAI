"""LiteLLM client for the help bot. Uses the fast model unless SUPPORT_LLM_MODEL is set, with the same provider
settings (and Z.ai reasoning knobs) as the rest of the app."""

import json
import logging
import re
from collections.abc import AsyncGenerator

import litellm
from pydantic import BaseModel, Field

from app.config import settings
from app.llm.provider import _extra_kwargs

log = logging.getLogger("notestack.support")


class LLMError(RuntimeError):
    pass


def model_name() -> str:
    return settings.support_llm_model or settings.llm_fast_model


class Meta(BaseModel):
    citations: list[str] = Field(default_factory=list)
    escalate: bool = False


def _kwargs(max_tokens: int, temperature: float) -> dict:
    return dict(
        model=model_name(),
        api_base=settings.llm_api_base or None,
        api_key=settings.llm_api_key or None,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout=40,
        num_retries=1,
        **_extra_kwargs("low"),
    )


async def stream_answer(messages: list[dict]) -> AsyncGenerator[str, None]:
    """Answer text only. Reasoning tokens (GLM thinks first) arrive in a separate field and are never forwarded."""
    try:
        stream = await litellm.acompletion(messages=messages, stream=True, **_kwargs(4000, 0.3))
        async for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                yield delta
    except Exception as exc:  # litellm raises many provider specific types
        log.warning("support stream failed: %s", exc)
        raise LLMError(str(exc)) from exc


async def complete_text(messages: list[dict], max_tokens: int = 600) -> str:
    try:
        resp = await litellm.acompletion(messages=messages, **_kwargs(max_tokens, 0.2))
    except Exception as exc:
        log.warning("support completion failed: %s", exc)
        raise LLMError(str(exc)) from exc
    return (resp.choices[0].message.content or "").strip()


def parse_meta(text: str) -> Meta:
    """Direct JSON, then fenced JSON, then the first {...} anywhere. Unparseable means empty metadata."""
    candidates = [text]
    fence = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
    if fence:
        candidates.append(fence.group(1))
    obj = re.search(r"\{[\s\S]*\}", text)
    if obj:
        candidates.append(obj.group(0))
    for raw in candidates:
        try:
            return Meta.model_validate(json.loads(raw))
        except Exception:
            continue
    return Meta()


async def complete_meta(messages: list[dict]) -> Meta:
    return parse_meta(await complete_text(messages, max_tokens=1500))
