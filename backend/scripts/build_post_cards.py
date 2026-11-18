"""Build post cards (app/pipeline/cards.py) for posts that were added before cards existed.

New and changed posts get a card automatically after every import. Run this once per environment for the rest:

  .venv/bin/python scripts/build_post_cards.py --workspace <id>          # queue a job for one workspace
  .venv/bin/python scripts/build_post_cards.py --all                     # queue a job for every workspace
  .venv/bin/python scripts/build_post_cards.py --notebook <id> --now     # build here and wait (for a test notebook)

--force rebuilds cards that are already up to date (after changing the PostCard prompt). Queued jobs run in the
worker; their progress shows in the jobs table (kind post_cards). One fast-model call per post."""

import argparse
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.corpus import Corpus  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import Document, Notebook, NotebookDocument, Workspace  # noqa: E402
from app.pipeline.cards import build_cards, cards_for_documents  # noqa: E402
from app.services.jobs import create_job  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--workspace")
    target.add_argument("--notebook")
    target.add_argument("--all", action="store_true")
    ap.add_argument("--now", action="store_true", help="build in this process instead of queueing a worker job")
    ap.add_argument("--force", action="store_true", help="rebuild cards that are already up to date")
    args = ap.parse_args()
    db = SessionLocal()
    try:
        if args.notebook:
            nb = db.get(Notebook, uuid.UUID(args.notebook))
            if nb is None:
                sys.exit("No such notebook")
            rows = db.execute(select(Document.id, Document.path, Document.title)
                              .join(NotebookDocument, NotebookDocument.document_id == Document.id)
                              .where(NotebookDocument.notebook_id == nb.id, Document.path.is_not(None))).all()
            if args.now:
                result = build_cards(Corpus(nb.workspace_id), {p: t or p for _, p, t in rows}, args.force)
                print(f"Notebook {nb.title!r}: {result}")
            else:
                job = create_job(db, nb.workspace_id, "post_cards",
                                 {"document_ids": [str(i) for i, _, _ in rows], "force": args.force}, max_attempts=2)
                print(f"Queued post_cards job {job.id} for {len(rows)} posts of notebook {nb.title!r}")
            return
        workspaces = ([uuid.UUID(args.workspace)] if args.workspace
                      else list(db.scalars(select(Workspace.id))))
        for ws in workspaces:
            if args.now:
                print(f"Workspace {ws}: {cards_for_documents(db, ws, None, args.force)}")
            else:
                job = create_job(db, ws, "post_cards", {"force": args.force}, max_attempts=2)
                print(f"Queued post_cards job {job.id} for workspace {ws}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
