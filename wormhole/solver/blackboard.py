"""In-process blackboard: the Fact/Intent/Hint DAG (Cairn-style).

This is a faithful re-implementation of Cairn's server data model, collapsed
from an HTTP server (7 tables + FastAPI routes) into a single in-process
Python class with SQLite WAL persistence. One Blackboard == one challenge.

Design (from Cairn's docs/specs/server-protocol.md):
  - The board is a DAG. ``Fact`` nodes are immutable (append-only); ``Intent``
    edges carry the exploration toward new Facts.
  - Intent has NO explicit status field. State is *derived* from three columns:
      to_fact_id IS NULL AND worker IS NULL      → unclaimed (open)
      to_fact_id IS NULL AND worker IS NOT NULL  → claimed (working)
      to_fact_id IS NOT NULL                      → concluded
  - Stale workers (heartbeat exceeded) are auto-reclaimed to NULL.
  - IDs: f001/f002... (facts), i001/i002... (intents), h001... (hints).
    Reserved fact ids: ``origin`` (start) and ``goal`` (target).

Why not Cairn's HTTP server? Cairn needs multi-project, multi-worker-backend,
and a web UI, so it splits server + dispatcher across processes. This solver
runs one challenge at a time in one process — a direct method-call API is
simpler and behaviourally identical.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Generator

logger = logging.getLogger(__name__)

SCHEMA = """\
CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    to_fact_id TEXT,
    description TEXT NOT NULL,
    creator TEXT NOT NULL,
    worker TEXT,
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    concluded_at TEXT
);
CREATE TABLE IF NOT EXISTS intent_sources (
    intent_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (intent_id, fact_id),
    FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hints (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
    kind TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class Fact:
    id: str
    description: str


@dataclass
class Intent:
    id: str
    from_: list[str] = field(default_factory=list)
    to: str | None = None
    description: str = ""
    creator: str = ""
    worker: str | None = None
    last_heartbeat_at: str | None = None
    created_at: str = ""
    concluded_at: str | None = None

    @property
    def is_open(self) -> bool:
        """True if not yet concluded (regardless of claim)."""
        return self.to is None

    @property
    def is_unclaimed(self) -> bool:
        """True if open AND no worker is currently on it."""
        return self.to is None and self.worker is None


@dataclass
class Hint:
    id: str
    content: str
    creator: str
    created_at: str


class Blackboard:
    """The shared knowledge graph for one challenge.

    Not thread-safe by itself; the dispatcher calls it from the asyncio event
    loop thread. SQLite WAL mode allows concurrent readers (e.g. the CLI
    inspecting progress) without blocking writes.
    """

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path), isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        # WAL for reader/writer concurrency + safe crash recovery.
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        # Track graph changes so the dispatcher knows when to re-reason.
        self._fact_count = 0
        self._hint_count = 0
        self._open_intent_count = 0

    @contextmanager
    def _txn(self) -> Generator[sqlite3.Connection, None, None]:
        """Wrap a unit of work in a transaction (nested-safe via SAVEPOINT).

        SQLite doesn't allow BEGIN within an active transaction, so when this
        is called from inside another ``_txn`` we use a savepoint instead.
        This lets ``conclude()`` call ``add_fact()`` (which each open their own
        txn) without "cannot start a transaction within a transaction" errors.
        """
        in_transaction = self._conn.in_transaction
        if in_transaction:
            # Nested call: use a savepoint so the inner block can roll back
            # independently without aborting the outer transaction.
            sp = f"sp_{uuid.uuid4().hex[:8]}"
            self._conn.execute(f"SAVEPOINT {sp}")
            try:
                yield self._conn
                self._conn.execute(f"RELEASE SAVEPOINT {sp}")
            except Exception:
                self._conn.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                self._conn.execute(f"RELEASE SAVEPOINT {sp}")
                raise
        else:
            self._conn.execute("BEGIN")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    # ------------------------------------------------------------------ #
    # ID generation (Cairn-style scoped counters: f001, i001, h001)
    # ------------------------------------------------------------------ #

    def _next_id(self, kind: str, prefix: str) -> str:
        with self._txn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO counters (kind, value) VALUES (?, 0)", (kind,)
            )
            conn.execute("UPDATE counters SET value = value + 1 WHERE kind = ?", (kind,))
            row = conn.execute("SELECT value FROM counters WHERE kind = ?", (kind,)).fetchone()
        return f"{prefix}{row['value']:03d}"

    # ------------------------------------------------------------------ #
    # Project lifecycle
    # ------------------------------------------------------------------ #

    def create_project(self, origin: str, goal: str) -> None:
        """Seed the board with the two reserved facts: origin and goal."""
        with self._txn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO facts (id, description) VALUES ('origin', ?)",
                (origin,),
            )
            conn.execute(
                "INSERT OR IGNORE INTO facts (id, description) VALUES ('goal', ?)",
                (goal,),
            )
        self._refresh_change_trackers()

    @property
    def is_initial(self) -> bool:
        """True if only origin+goal exist and no intent has been created yet."""
        return self._fact_count <= 2 and not self.all_intents

    # ------------------------------------------------------------------ #
    # Facts
    # ------------------------------------------------------------------ #

    def add_fact(self, description: str) -> str:
        """Append an immutable fact; returns its id (f001...)."""
        fid = self._next_id("fact", "f")
        with self._txn() as conn:
            conn.execute(
                "INSERT INTO facts (id, description) VALUES (?, ?)", (fid, description)
            )
        self._fact_count += 1
        logger.debug("blackboard: +fact %s: %s", fid, description[:80])
        return fid

    def get_fact(self, fid: str) -> Fact | None:
        row = self._conn.execute(
            "SELECT id, description FROM facts WHERE id = ?", (fid,)
        ).fetchone()
        return Fact(id=row["id"], description=row["description"]) if row else None

    @property
    def facts(self) -> list[Fact]:
        rows = self._conn.execute("SELECT id, description FROM facts ORDER BY id").fetchall()
        return [Fact(id=r["id"], description=r["description"]) for r in rows]

    # ------------------------------------------------------------------ #
    # Hints
    # ------------------------------------------------------------------ #

    def add_hint(self, content: str, creator: str = "solver") -> str:
        hid = self._next_id("hint", "h")
        with self._txn() as conn:
            conn.execute(
                "INSERT INTO hints (id, content, creator, created_at) VALUES (?, ?, ?, ?)",
                (hid, content, creator, _now_iso()),
            )
        self._hint_count += 1
        return hid

    @property
    def hints(self) -> list[Hint]:
        rows = self._conn.execute(
            "SELECT id, content, creator, created_at FROM hints ORDER BY id"
        ).fetchall()
        return [
            Hint(id=r["id"], content=r["content"], creator=r["creator"], created_at=r["created_at"])
            for r in rows
        ]

    # ------------------------------------------------------------------ #
    # Intents (the exploration edges)
    # ------------------------------------------------------------------ #

    def create_intent(self, from_ids: list[str], description: str, creator: str = "reason") -> str:
        """Declare a new exploration direction. ``from_ids`` may be multiple (hyperedge)."""
        if not from_ids:
            raise ValueError("intent needs at least one source fact")
        iid = self._next_id("intent", "i")
        with self._txn() as conn:
            conn.execute(
                "INSERT INTO intents (id, to_fact_id, description, creator, worker, "
                "last_heartbeat_at, created_at, concluded_at) "
                "VALUES (?, NULL, ?, ?, NULL, NULL, ?, NULL)",
                (iid, description, creator, _now_iso()),
            )
            for fid in from_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO intent_sources (intent_id, fact_id) VALUES (?, ?)",
                    (iid, fid),
                )
        self._open_intent_count += 1
        logger.debug("blackboard: +intent %s from %s: %s", iid, from_ids, description[:80])
        return iid

    def claim_intent(self, iid: str, worker: str) -> None:
        """A worker takes ownership of an open intent."""
        with self._txn() as conn:
            cur = conn.execute(
                "UPDATE intents SET worker = ?, last_heartbeat_at = ? "
                "WHERE id = ? AND to_fact_id IS NULL",
                (worker, _now_iso(), iid),
            )
            if cur.rowcount == 0:
                raise ValueError(f"intent {iid} not found or already concluded")

    def heartbeat(self, iid: str) -> None:
        """Refresh the claim lease (called while a worker is still grinding)."""
        self._conn.execute(
            "UPDATE intents SET last_heartbeat_at = ? WHERE id = ? AND to_fact_id IS NULL",
            (_now_iso(), iid),
        )

    def release(self, iid: str) -> None:
        """Give up a claim without concluding (intent returns to unclaimed)."""
        self._conn.execute(
            "UPDATE intents SET worker = NULL, last_heartbeat_at = NULL "
            "WHERE id = ? AND to_fact_id IS NULL",
            (iid,),
        )

    def conclude(self, iid: str, fact_description: str) -> str:
        """Atomically: append a new Fact AND link this intent to it (to_fact_id).

        This is the core state transition — an open intent becomes concluded,
        its finding recorded as an immutable Fact. Returns the new fact id.

        The fact INSERT and the intent UPDATE run in a SINGLE transaction so
        that if the intent is already concluded (rowcount==0), the fact INSERT
        is rolled back too — no orphan facts. Previously ``add_fact`` was called
        first (which commits independently), leaving a leaked fact on failure.
        """
        fid = self._next_id("fact", "f")
        with self._txn() as conn:
            conn.execute(
                "INSERT INTO facts (id, description) VALUES (?, ?)",
                (fid, fact_description),
            )
            cur = conn.execute(
                "UPDATE intents SET to_fact_id = ?, worker = ?, concluded_at = ? "
                "WHERE id = ? AND to_fact_id IS NULL",
                (fid, self._intent_worker(iid) or "unknown", _now_iso(), iid),
            )
            if cur.rowcount == 0:
                # _txn's except will ROLLBACK the INSERT above — no orphan fact.
                raise ValueError(f"intent {iid} not found or already concluded")
        self._fact_count += 1
        # Concluding reduces open-intent count; a new fact was added above.
        self._open_intent_count = max(0, self._open_intent_count - 1)
        logger.info("blackboard: intent %s → fact %s", iid, fid)
        return fid

    def _intent_worker(self, iid: str) -> str | None:
        row = self._conn.execute("SELECT worker FROM intents WHERE id = ?", (iid,)).fetchone()
        return row["worker"] if row else None

    def get_intent(self, iid: str) -> Intent | None:
        row = self._conn.execute("SELECT * FROM intents WHERE id = ?", (iid,)).fetchone()
        if not row:
            return None
        srcs = self._conn.execute(
            "SELECT fact_id FROM intent_sources WHERE intent_id = ? ORDER BY fact_id", (iid,)
        ).fetchall()
        return Intent(
            id=row["id"],
            from_=[s["fact_id"] for s in srcs],
            to=row["to_fact_id"],
            description=row["description"],
            creator=row["creator"],
            worker=row["worker"],
            last_heartbeat_at=row["last_heartbeat_at"],
            created_at=row["created_at"],
            concluded_at=row["concluded_at"],
        )

    @property
    def all_intents(self) -> list[Intent]:
        rows = self._conn.execute("SELECT id FROM intents ORDER BY id").fetchall()
        return [intent for r in rows if (intent := self.get_intent(r["id"]))]

    @property
    def open_intents(self) -> list[Intent]:
        """Intents not yet concluded (may be claimed or unclaimed)."""
        rows = self._conn.execute(
            "SELECT id FROM intents WHERE to_fact_id IS NULL ORDER BY id"
        ).fetchall()
        return [intent for r in rows if (intent := self.get_intent(r["id"]))]

    @property
    def unclaimed_intents(self) -> list[Intent]:
        """Open intents with no active worker — ready for an explore task."""
        rows = self._conn.execute(
            "SELECT id FROM intents WHERE to_fact_id IS NULL AND worker IS NULL ORDER BY id DESC"
        ).fetchall()
        # DESC: prefer newest (most relevant) unclaimed intent first.
        return [intent for r in rows if (intent := self.get_intent(r["id"]))]

    # ------------------------------------------------------------------ #
    # Completion & expiry
    # ------------------------------------------------------------------ #

    def complete(self, from_ids: list[str], description: str) -> str:
        """Mark the goal as reached: a concluding intent → the 'goal' fact."""
        fid = self.add_fact(description) if description.strip() else "goal"
        with self._txn() as conn:
            iid = self._next_id("intent", "i")
            conn.execute(
                "INSERT INTO intents (id, to_fact_id, description, creator, worker, "
                "last_heartbeat_at, created_at, concluded_at) "
                "VALUES (?, 'goal', ?, 'reason', 'reason', ?, ?, ?)",
                (iid, description, _now_iso(), _now_iso(), _now_iso()),
            )
            for src in from_ids or ["origin"]:
                conn.execute(
                    "INSERT OR IGNORE INTO intent_sources (intent_id, fact_id) VALUES (?, ?)",
                    (iid, src),
                )
        logger.info("blackboard: COMPLETED via intent %s → goal", iid)
        return iid

    @property
    def is_completed(self) -> bool:
        """True once any intent concludes into the 'goal' fact."""
        row = self._conn.execute(
            "SELECT 1 FROM intents WHERE to_fact_id = 'goal' LIMIT 1"
        ).fetchone()
        return row is not None

    def clear_completion(self) -> None:
        """Remove a premature goal-completion so the loop can continue.

        Called by the dispatcher when ``is_completed`` is true but not enough
        flags have been found yet. Deletes the goal-linking intent(s) but keeps
        all the facts they produced — only the false "done" marker is removed.
        """
        with self._txn() as conn:
            goal_intents = [
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM intents WHERE to_fact_id = 'goal'"
                ).fetchall()
            ]
            for iid in goal_intents:
                conn.execute(
                    "DELETE FROM intent_sources WHERE intent_id = ?", (iid,)
                )
                conn.execute("DELETE FROM intents WHERE id = ?", (iid,))
        if goal_intents:
            # Fix counter: each deleted goal-intent was a concluded (closed)
            # intent, so removing it increases the open-intent count. Without
            # this fix, checkpoint() returns a stale count and the dispatcher
            # may misjudge "has the graph changed?" → spurious re-reason.
            self._open_intent_count += len(goal_intents)
            logger.info(
                "blackboard: cleared %d premature goal-completion(s)", len(goal_intents)
            )

    def expire_stale(self, timeout_sec: float) -> int:
        """Reclaim intents whose heartbeat is older than ``timeout_sec``.

        Returns the number of intents reclaimed. Uses SQLite's julianday for
        portable time arithmetic (same approach as Cairn's expire_workers).
        """
        with self._txn() as conn:
            cur = conn.execute(
                "UPDATE intents SET worker = NULL, last_heartbeat_at = NULL "
                "WHERE to_fact_id IS NULL AND worker IS NOT NULL "
                "AND last_heartbeat_at IS NOT NULL "
                "AND (julianday(?) - julianday(last_heartbeat_at)) * 86400 > ?",
                (_now_iso(), timeout_sec),
            )
            n = cur.rowcount
        if n:
            logger.info("blackboard: expired %d stale intent(s)", n)
        return n

    # ------------------------------------------------------------------ #
    # Change tracking (drives the dispatcher's "should I reason?" decision)
    # ------------------------------------------------------------------ #

    def _refresh_change_trackers(self) -> None:
        self._fact_count = self._conn.execute("SELECT COUNT(*) c FROM facts").fetchone()["c"]
        self._hint_count = self._conn.execute("SELECT COUNT(*) c FROM hints").fetchone()["c"]
        self._open_intent_count = self._conn.execute(
            "SELECT COUNT(*) c FROM intents WHERE to_fact_id IS NULL"
        ).fetchone()["c"]

    def checkpoint(self) -> tuple[int, int, int]:
        """Snapshot the counters; compare with ``has_changed_since`` later."""
        self._refresh_change_trackers()
        return (self._fact_count, self._hint_count, self._open_intent_count)

    def has_changed_since(self, cp: tuple[int, int, int]) -> bool:
        """True if facts/hints/open-intents changed since the checkpoint."""
        return self.checkpoint() != cp

    @property
    def reason_busy(self) -> bool:
        """Placeholder for project-level reason lease (single-worker: always free)."""
        return False

    # ------------------------------------------------------------------ #
    # Export (graph snapshot for reason/explore prompts)
    # ------------------------------------------------------------------ #

    def export_yaml(self) -> str:
        """Render the whole graph as YAML for the worker to read.

        Facts are annotated with ``dead_end: true`` when they contain strong
        negative-conclusion signals (e.g. "not injectable", "ruled out").
        This lets the AI in the reason phase immediately see which directions
        have already been ruled out, without having to read every fact
        description in full and infer it. The AI can then focus its planning
        on unexplored attack surfaces instead of re-trying dead ends.
        """
        from wormhole.solver.constants import DEAD_END_PHRASES, POSITIVE_SIGNALS

        facts = self.facts
        origin = next((f.description for f in facts if f.id == "origin"), "")
        goal = next((f.description for f in facts if f.id == "goal"), "")
        hints = self.hints
        intents = self.all_intents

        lines: list[str] = []
        lines.append("project:")
        lines.append(f"  origin: {_yaml_scalar(origin)}")
        lines.append(f"  goal: {_yaml_scalar(goal)}")
        if hints:
            lines.append("hints:")
            for h in hints:
                lines.append(f"  - content: {_yaml_scalar(h.content)}")
                lines.append(f"    creator: {h.creator}")

        # Partition facts: actionable vs dead_end, for a summary header.
        # Classification mirrors webui._extract_dead_ends:
        #   - a STRONG positive signal (flag, RCE confirmed, ...) wins → not dead-end
        #   - else a strong dead-end phrase → dead-end
        actionable = []
        dead_ends = []
        for f in facts:
            lower = f.description.lower()
            has_strong_positive = any(sig in lower for sig in POSITIVE_SIGNALS)
            has_negative = any(phrase in lower for phrase in DEAD_END_PHRASES)
            is_dead_end = (
                has_negative
                and not has_strong_positive
                and f.id not in ("origin", "goal")
            )
            entry = {
                "id": f.id,
                "description": f.description,
                "dead_end": is_dead_end,
            }
            if is_dead_end:
                dead_ends.append(entry)
            else:
                actionable.append(entry)

        # Summary header — gives the AI a quick orientation
        lines.append(f"# Graph summary: {len(actionable)} actionable facts, "
                      f"{len(dead_ends)} dead-end conclusions, "
                      f"{len(intents)} intents.")

        lines.append("facts:")
        for f in facts:
            lines.append(f"  - id: {f.id}")
            lines.append(f"    description: {_yaml_scalar(f.description)}")
            # Annotate dead-end facts so the AI can skip them at a glance.
            # Same priority logic as the partition above.
            lower = f.description.lower()
            has_strong_positive = any(sig in lower for sig in POSITIVE_SIGNALS)
            has_negative = any(phrase in lower for phrase in DEAD_END_PHRASES)
            if has_negative and not has_strong_positive and f.id not in ("origin", "goal"):
                lines.append(f"    dead_end: true")

        # Explicit dead-end summary block — the AI reads this first
        if dead_ends:
            lines.append("")
            lines.append("# ── DEAD ENDS (already ruled out — do NOT retry these) ──")
            for de in dead_ends:
                # Short summary: first 120 chars after removing common prefixes
                summary = de["description"][:120]
                lines.append(f"#   [{de['id']}] {summary}")

        if intents:
            lines.append("intents:")
            for it in intents:
                lines.append(f"  - id: {it.id}")
                lines.append(f"    from: [{', '.join(it.from_)}]")
                to = it.to if it.to else "null"
                lines.append(f"    to: {to}")
                lines.append(f"    description: {_yaml_scalar(it.description)}")
                lines.append(f"    creator: {it.creator}")
                lines.append(f"    worker: {it.worker or 'null'}")
                lines.append(f"    created_at: {it.created_at}")
                if it.concluded_at:
                    lines.append(f"    concluded_at: {it.concluded_at}")
        return "\n".join(lines) + "\n"

    # ------------------------------------------------------------------ #
    # Cleanup
    # ------------------------------------------------------------------ #

    def close(self) -> None:
        self._conn.close()


def _yaml_scalar(text: str) -> str:
    """Quote a YAML scalar if it needs quoting; else emit bare.

    Good enough for our flat key:value lists — avoids a PyYAML dependency.
    Multiline or leading-special chars force double-quoting.
    """
    if not text:
        return '""'
    if any(c in text for c in "\n:#{}[]&*!|>'\"%@`") or text[0] in "-? ":
        # Escape backslash and double-quote, wrap in double quotes.
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return text
