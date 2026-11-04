"""Capability adapters for delivering finished NoteStack artifacts to connected apps.

Artifact generation and destination delivery are deliberately independent.  A route
selects an adapter from the enabled remote tool names; it never selects a hard-coded
``artifact + app`` pair.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class DeliveryAdapter:
    key: str
    required_tools: frozenset[str]
    placeholder: bool
    label: str


ADAPTERS = (
    DeliveryAdapter(
        key="notion_page",
        required_tools=frozenset({"notion-create-pages", "notion-update-page"}),
        placeholder=True,
        label="page",
    ),
    DeliveryAdapter(
        key="async_design",
        required_tools=frozenset({"create-design", "get-create-design-async-job"}),
        placeholder=False,
        label="design",
    ),
)


def adapter_for_tools(tool_names: set[str] | list[str]) -> DeliveryAdapter | None:
    """Return the first adapter whose complete capability set is enabled."""
    available = set(tool_names)
    return next((adapter for adapter in ADAPTERS if adapter.required_tools <= available), None)
