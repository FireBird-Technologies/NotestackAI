"""A simple per-connection rate limit. In memory and per process: it stops a runaway assistant, it does not meter plans
(the API's own plan limits do that)."""

import time
from collections import defaultdict, deque

WINDOW = 60.0
PER_MINUTE = 120  # cost points a connection may spend a minute; a generate_* call costs 10

_calls: dict[str, deque] = defaultdict(deque)


def allow(key: str, cost: int = 1, now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    q = _calls[key]
    while q and now - q[0][0] > WINDOW:
        q.popleft()
    if sum(c for _, c in q) + cost > PER_MINUTE:
        return False
    q.append((now, cost))
    return True


def reset() -> None:
    _calls.clear()
