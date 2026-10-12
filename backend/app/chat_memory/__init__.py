"""Chat memory: a notebook's chats kept as topic files in R2, so a chat can pick up where it left off and a writer can
ask about something said earlier. See docs/CHAT_RECALL_IMPLEMENTATION.md.

The database keeps every message. This package keeps what was learned from them: a summary, keywords and a few
exact quotes per topic. Only the background job writes these files (organize.py)."""
