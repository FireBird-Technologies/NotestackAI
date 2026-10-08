"""The help corpus: markdown files in support/docs, one topic each, loaded once per process.

Each file starts with a small frontmatter block (title, route, keywords, questions, related). The bot answers only
from these files, so a feature is documented here before the bot can talk about it.
"""

import logging
import re
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("notestack.support")

DOCS_DIR = Path(__file__).parent / "docs"
_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)


@dataclass(frozen=True)
class Doc:
    id: str
    title: str
    route: str
    keywords: tuple[str, ...]
    questions: tuple[str, ...]
    related_paths: tuple[str, ...]
    headings: tuple[str, ...]
    body: str

    @property
    def high_signal_text(self) -> str:
        return "\n".join([self.title, *self.keywords, *self.headings, *self.questions])


def _parse(path: Path) -> Doc:
    raw = path.read_text(encoding="utf-8")
    match = _FRONTMATTER.match(raw)
    meta: dict[str, list[str] | str] = {}
    body = raw
    if match:
        body = raw[match.end():]
        key = ""
        for line in match.group(1).splitlines():
            if line.startswith("  - ") and key:
                meta.setdefault(key, []).append(line[4:].strip())  # type: ignore[union-attr]
            elif ":" in line:
                key, _, value = line.partition(":")
                key, value = key.strip(), value.strip()
                meta[key] = value if value else []
    as_list = lambda k: tuple(meta.get(k) or ())  # noqa: E731
    return Doc(
        id=path.stem,
        title=str(meta.get("title") or path.stem.replace("-", " ").title()),
        route=str(meta.get("route") or ""),
        keywords=as_list("keywords"),
        questions=as_list("questions"),
        related_paths=as_list("related"),
        headings=tuple(re.findall(r"^#{1,3}\s+(.+)$", body, re.M)),
        body=body.strip(),
    )


def _count(n: int) -> str:
    return "unlimited" if n < 0 else str(n)


def _plans_doc() -> Doc:
    """Built from services/plans.py so prices and limits can never drift from what the app enforces."""
    from app.services.plans import PLANS, annual_prices, plan_order

    order = plan_order()  # the plans table's (editable without a deploy), so the names and count come from it too
    names = [PLANS[pid].name for pid in order]
    listed = ", ".join(names[:-1]) + f" and {names[-1]}" if len(names) > 1 else "".join(names)
    lines = ["# Plans", f"Notestack has {len(names)} plans: {listed}. Prices are in US dollars."]
    for pid in order:
        p = PLANS[pid]
        price = "free" if not p.price_monthly_usd else f"${p.price_monthly_usd:g} a month"
        if p.price_monthly_usd:
            monthly, yearly = annual_prices(p)
            price += f", or ${monthly:g} a month billed yearly (${yearly:g} a year)"
        per = "in total (never renewing)" if p.lifetime else "a month"

        audio = f"{_count(p.audio_overviews)} audio overviews in total, any length" if p.audio_overviews >= 0 \
            else f"{p.audio_minutes} minutes of audio a month"
        lines += [
            f"## {p.name}",
            f"{p.tagline}. Price: {price}.",
            f"Limits: {_count(p.sources)} sources, {p.indexed_posts} indexed posts across every source, {audio}, "
            f"{p.videos} videos {'a month' if p.videos_monthly else 'in total, never renewing'}, "
            f"{_count(p.launch_kits)} Launch Kits {per}, {_count(p.infographics)} infographics {per}, "
            f"{_count(p.reports)} reports a month. "
            f"Voice cloning: {'yes' if p.voice_cloning else 'no'}.",
            "Includes: " + "; ".join(p.features) + ".",
        ]
    lines += [
        "## Billing",
        "Upgrade, change plan or manage billing from Settings under Plan and usage. "
        "Monthly and yearly prices are listed above. Checkout may be switched off while billing is being finished, "
        "in which case every workspace gets Studio limits.",
        "Refunds and billing problems are handled by the team: use the Talk to a human button in this chat.",
    ]
    body = "\n".join(lines)
    return Doc(
        id="plans-and-billing", title="Plans, pricing and billing", route="/pricing",
        keywords=("price", "pricing", "plan", "plans", "free", "writer", "studio", "cost", "billing", "upgrade",
                  "limits", "annual", "monthly", "subscription", "refund", "cancel", "usage", "reports", "infographics"),
        questions=("How much does Notestack cost?", "What is in the free plan?", "What are the plan limits?",
                   "How do I upgrade?", "Is there annual billing?"),
        related_paths=("/app/settings",), headings=tuple(re.findall(r"^#{1,3}\s+(.+)$", body, re.M)), body=body,
    )


_docs: list[Doc] | None = None


def get_corpus() -> list[Doc]:
    global _docs
    if _docs is None:
        _docs = [_parse(p) for p in sorted(DOCS_DIR.glob("*.md"))] + [_plans_doc()]
        log.info("support corpus: %d docs", len(_docs))
    return _docs
