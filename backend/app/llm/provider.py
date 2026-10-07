"""Provider agnostic LLM factory. Any LiteLLM model string works; Z.ai GLM is the default.

Examples:
  Z.ai:       LLM_MODEL=openai/glm-5.3  LLM_API_BASE=https://api.z.ai/api/paas/v4
  Anthropic:  LLM_MODEL=anthropic/claude-sonnet-5  LLM_API_BASE=
  OpenAI:     LLM_MODEL=openai/gpt-5  LLM_API_BASE=
  Local:      LLM_MODEL=ollama_chat/qwen3  LLM_API_BASE=http://localhost:11434
"""

from contextlib import contextmanager
from dataclasses import dataclass
from functools import lru_cache

import dspy

from app.config import settings


def is_zai() -> bool:
    return "z.ai" in settings.llm_api_base or "bigmodel.cn" in settings.llm_api_base


def _extra_kwargs(effort: str | None) -> dict:
    if not is_zai():
        return {}
    # GLM-5.x always reasons; thinking.type only accepts "enabled". Cost and latency are tuned
    # with reasoning_effort (low | high | max) instead. extra_body fields land top level in the request.
    effort = effort or settings.llm_reasoning_effort
    return {"extra_body": {"thinking": {"type": "enabled"}, "reasoning_effort": effort}}


def _build(model: str, *, effort: str | None, temperature: float | None, max_tokens: int | None) -> dspy.LM:
    return dspy.LM(
        model,
        api_base=settings.llm_api_base or None,
        api_key=settings.llm_api_key or None,
        temperature=settings.llm_temperature if temperature is None else temperature,
        max_tokens=max_tokens or settings.llm_max_tokens,
        cache=True,
        **_extra_kwargs(effort),
    )


@lru_cache
def main_lm(effort: str | None = None) -> dspy.LM:
    """effort overrides LLM_REASONING_EFFORT per module, e.g. main_lm("high") for the groundedness judge."""
    return _build(settings.llm_model, effort=effort, temperature=None, max_tokens=None)


@lru_cache
def fast_lm() -> dspy.LM:
    return _build(settings.llm_fast_model, effort="low", temperature=None, max_tokens=8000)


REPORT_MAX_TOKENS = 16000  # a few pages of prose plus GLM's low-effort reasoning


@lru_cache
def report_lm() -> dspy.LM:
    """Writes reports: the fast model unless LLM_REPORT_MODEL names another, with room for a long answer."""
    return _build(settings.llm_report_model or settings.llm_fast_model, effort="low", temperature=None,
                  max_tokens=REPORT_MAX_TOKENS)


@lru_cache
def triage_lm() -> dspy.LM:
    """Cheap model that decides whether a chat message needs research at all."""
    if not settings.llm_triage_model:
        return fast_lm()
    return _build(settings.llm_triage_model, effort="low", temperature=0.2, max_tokens=2000)


FOCUS_MAX_TOKENS = 2000  # three titles and two-line descriptions plus GLM's low-effort reasoning


@lru_cache
def focus_lm(retry: bool = False) -> dspy.LM:
    """The video wizard's focus suggestions: a little material in, three short topics out, so a small cap keeps it
    quick. Only for a source with no topics to show. retry=True is the second try after an unusable answer: a
    different temperature, so it is a fresh call and not that answer again from the cache."""
    return _build(settings.llm_fast_model, effort="low", temperature=0.8 if retry else 0.4,
                  max_tokens=FOCUS_MAX_TOKENS)


def configure_default() -> None:
    dspy.configure(lm=main_lm(), adapter=dspy.JSONAdapter())


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@contextmanager
def track_usage(lm: dspy.LM):
    """Collect token usage for calls made inside the block (for usage_events metering)."""
    usage = Usage()
    start = len(lm.history)
    try:
        yield usage
    finally:
        for entry in lm.history[start:]:
            u = entry.get("usage") or {}
            usage.prompt_tokens += int(u.get("prompt_tokens") or 0)
            usage.completion_tokens += int(u.get("completion_tokens") or 0)
            usage.cost_usd += float(entry.get("cost") or 0.0)


def provider_name(model: str | None = None) -> str:
    model = model or settings.llm_model
    return "zai" if is_zai() and model.startswith("openai/") else model.split("/", 1)[0]
