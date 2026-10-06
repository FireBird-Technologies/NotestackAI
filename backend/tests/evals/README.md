# evals

Tests that check how a model or classifier behaves on labeled examples, not just that the code runs.

| File | What it checks |
|---|---|
| `test_memory_gate.py` | The Jev gate that decides whether a chat message is worth a memory extraction call: the wording, the skip threshold, and 29 labeled messages |
| `test_memory_extraction.py` | The prompt that decides which notes to save from a message, on labeled messages |
| `test_chat_recall.py` | The chat memory organizer: files a chat's rounds under topics, reopens an old topic after a detour, writes synonyms as keywords, and picks the answers worth keeping |
| `test_chat_tool_use.py` | The research agent's tool calls on a real bugged chat (Neo4j follow ups that stayed on one remembered post): does it list or search the whole archive, read the post devoted to the question, and cite it? Set `EVAL_BASELINE=1` to run the prompt from before the fix for comparison |

The always-on tests in each file run with the normal suite. Tests that call a real service are opt-in: they use the keys
from your `.env` (see `live.py`) and only run with `LIVE_EVALS=1`, for example:

    LIVE_EVALS=1 pytest tests/evals -k live
