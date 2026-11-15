"""Loads the agent runs written by `npm run eval:export` (scripts/export-eval-runs.ts)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

RUNS_DIR = Path(__file__).parent / "runs"


def load_runs() -> list[dict[str, Any]]:
    if not RUNS_DIR.is_dir():
        return []
    return [
        json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(RUNS_DIR.glob("*.json"))
        if not p.name.startswith("_")
    ]


def load_meta() -> dict[str, Any]:
    meta = RUNS_DIR / "_meta.json"
    return json.loads(meta.read_text(encoding="utf-8")) if meta.exists() else {}


def reply_text(run: dict[str, Any]) -> str:
    reply = run["result"].get("customerReply") or {}
    return f"{reply.get('subject', '')}\n{reply.get('body', '')}".strip()


def actual_output(run: dict[str, Any]) -> str:
    """What the customer and the payout system would see: the decision plus the reply."""
    r = run["result"]
    amount = "none" if r.get("refundAmount") is None else f"{r['refundAmount']:.2f} {r.get('currency', 'EUR')}"
    queue = (r.get("humanReview") or {}).get("queue") or "none"
    return (
        f"Decision: {r['decision']}\nRefund amount: {amount}\nHuman review queue: {queue}\n"
        f"Customer reply:\n{reply_text(run) or '(no reply)'}"
    )
