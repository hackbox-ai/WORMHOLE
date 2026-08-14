"""Wormhole Solver Web UI — FastAPI backend.

A lightweight local web dashboard for the CTF solver. Provides:
  - Challenge list and progress overview
  - Real-time solver logs via WebSocket
  - Blackboard DAG visualization data (facts/intents)
  - Start/stop solver runs from the browser

Usage:
    python -m wormhole.solver.webui
    # open http://localhost:8765

Does NOT modify the solver core — it wraps cli_solve's functions with
a web layer, replacing the _print callback with WebSocket broadcasts.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sqlite3
import time
from wormhole.solver.constants import DEAD_END_PHRASES, FLAG_RE, POSITIVE_SIGNALS
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"
# IMPORTANT: must match cli_solve.py's default `solver_runs/` (relative to cwd
# when launched from src/). Resolve to absolute so the webui finds DBs regardless
# of its own cwd. The CLI runs as `python -m wormhole.solver.cli_solve` from src/,
# so its `solver_runs/` = src/solver_runs. Anchor there.
RUNS_DIR = (Path(__file__).resolve().parent.parent.parent / "solver_runs").resolve()

# ──────────────────────────────────────────────────────────────
# Global solver state (shared across requests)
# ──────────────────────────────────────────────────────────────

CONFIG_FILE = Path(__file__).parent / ".webui_config.json"


class SolverState:
    """Tracks the running solver instance and broadcasts logs to WS clients."""

    def __init__(self) -> None:
        self.running = False
        self.task: asyncio.Task | None = None
        # Cooperative shutdown signal — set by /api/stop and lifespan shutdown.
        # Scheduler checks this between challenges to stop picking up new work
        # gracefully (vs hard asyncio.CancelledError which can interrupt the
        # cleanup `await` in solve_challenge's finally block).
        self.cancel_event: asyncio.Event = asyncio.Event()
        # Load config from file if it exists, otherwise use defaults
        self.config: dict[str, Any] = {
            "base_url": os.environ.get("BENCHMARK_BASE_URL", ""),
            "token": os.environ.get("BENCHMARK_TOKEN", ""),
            "anthropic_auth_token": "",
            "anthropic_base_url": "https://open.bigmodel.cn/api/anthropic",
            "anthropic_model": "glm-5.2",
            "concurrency": 3,
            "task_timeout": 600,   # synced with CLI default
            "max_rounds": 15,
            "difficulty": "",
            "only": "",
            # Advanced tuning (synced with CLI defaults)
            "flag_stagnation_base": 3,
            "flag_stagnation_per_flag": 2,
            "infra_down_threshold": 4,
        }
        self._load_config()
        self.outcomes: list[dict] = []
        self.clients: set[WebSocket] = set()

    def _load_config(self) -> None:
        """Load saved config from disk (survives browser refresh)."""
        try:
            if CONFIG_FILE.exists():
                saved = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                self.config.update(saved)
        except Exception:
            pass

    def _save_config(self) -> None:
        """Persist config to disk so browser refresh doesn't lose it."""
        try:
            CONFIG_FILE.write_text(json.dumps(self.config, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

    async def broadcast(self, msg: str, msg_type: str = "log") -> None:
        """Send a message to all connected WebSocket clients."""
        payload = json.dumps({"type": msg_type, "msg": msg}, ensure_ascii=False)
        dead = set()
        for ws in self.clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.add(ws)
        self.clients -= dead

    def log_callback(self, msg: str) -> None:
        """Sync callback used as the solver's `log` parameter.

        Schedules an async broadcast (the solver calls this from a thread via
        asyncio.to_thread, so we can't await directly).
        """
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(self.broadcast(msg), loop)
        except RuntimeError:
            pass  # No event loop yet — skip


state = SolverState()


# ──────────────────────────────────────────────────────────────
# Dead-end extraction — surfaces "what the AI already ruled out"
# ──────────────────────────────────────────────────────────────

# Dead-end extraction uses the shared constants from constants.py — single
# source of truth for both webui display and blackboard YAML annotation.
_DEAD_END_PHRASES = DEAD_END_PHRASES  # re-export for local use
_STRONG_POSITIVE = POSITIVE_SIGNALS   # re-export for local use


def _extract_dead_ends(facts: list[dict]) -> list[dict]:
    """Extract negative-conclusion facts (dead ends) from the blackboard.

    Classification priority (resolves the substring-collision problem):
      1. If the fact contains a STRONG positive signal (flag{...}, "RCE
         confirmed working", "successfully exploited", ...), it is NEVER a
         dead end — it's a confirmed finding, even if the description also
         recounts earlier failures.
      2. Else if it contains a strong dead-end phrase ("ruled out",
         "not injectable", "exhausted all", "no valid credentials", ...),
         it IS a dead end.
      3. Otherwise it's a neutral finding — not classified.

    Priority of (1) over (2) is correct because strong-positive phrases are
    unambiguous success markers, while dead-end phrases can appear inside
    success stories ("tried 5 dead ends, then RCE confirmed working").
    Generic positive words ("credential", "pivot", "discovered") are NOT in
    the strong list because they collide with negative sentences
    ("no valid credentials", "pivot host unreachable").
    """
    dead_ends = []
    for f in facts:
        if f["id"] in ("origin", "goal"):
            continue
        desc = f.get("description", "")
        if not desc or len(desc) < 20:
            continue
        lower = desc.lower()
        # Strong positive signal → confirmed finding, not a dead end.
        if any(sig in lower for sig in _STRONG_POSITIVE):
            continue
        # Strong dead-end phrase and no strong positive → dead end.
        if any(phrase in lower for phrase in _DEAD_END_PHRASES):
            dead_ends.append({"id": f["id"], "description": desc})
    return dead_ends


# ──────────────────────────────────────────────────────────────
# Blackboard reader (direct SQLite read, WAL-safe)
# ──────────────────────────────────────────────────────────────

def read_blackboard(db_path: Path) -> dict[str, Any]:
    """Read facts/intents/hints from a blackboard SQLite file.

    Opens readonly with WAL — safe to call while the solver is writing.
    """
    if not db_path.exists():
        return {"facts": [], "intents": [], "hints": [], "completed": False}

    conn = None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row

        facts = [
            {"id": r["id"], "description": r["description"]}
            for r in conn.execute("SELECT id, description FROM facts ORDER BY id")
        ]

        intents = []
        for r in conn.execute("SELECT * FROM intents ORDER BY id"):
            # Get source facts for this intent
            srcs = [
                s["fact_id"]
                for s in conn.execute(
                    "SELECT fact_id FROM intent_sources WHERE intent_id = ? ORDER BY fact_id",
                    (r["id"],),
                )
            ]
            intents.append({
                "id": r["id"],
                "from": srcs,
                "to": r["to_fact_id"],
                "description": r["description"],
                "worker": r["worker"],
                "created_at": r["created_at"],
                "concluded_at": r["concluded_at"],
            })

        hints = [
            {"id": r["id"], "content": r["content"], "creator": r["creator"]}
            for r in conn.execute("SELECT id, content, creator FROM hints ORDER BY id")
        ]

        completed = (
            conn.execute("SELECT 1 FROM intents WHERE to_fact_id = 'goal' LIMIT 1").fetchone()
            is not None
        )

        return {"facts": facts, "intents": intents, "hints": hints, "completed": completed}
    except Exception as exc:
        return {"facts": [], "intents": [], "hints": [], "completed": False, "error": str(exc)}
    finally:
        # ALWAYS close — previously conn.close() was inside the try block, so
        # any exception mid-read leaked the connection (called every 3s by the
        # dashboard poll, so leaks accumulated).
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


# Unified flag regex from constants.py (was locally compiled with different limits)
FLAG_RE = FLAG_RE  # re-export for local use


def build_timeline(bb: dict) -> list[dict]:
    """Reconstruct the OODA decision timeline from blackboard state.

    Reads facts + intents and produces a chronologically ordered event list
    showing HOW the AI solved the challenge — each reasoning step, each
    exploration, each discovery. This is the "thinking trace" that makes
    the blackboard's self-feedback loop visible.
    """
    events = []
    facts = {f["id"]: f for f in bb["facts"]}

    # Bootstrap: origin fact = initial recon (always step 1)
    if "origin" in facts:
        events.append({
            "step": 1, "phase": "bootstrap", "type": "recon",
            "desc": facts["origin"]["description"],
        })

    # Walk intents in order — each tells a story
    step = 2
    for it in bb["intents"]:
        # The intent itself = a reasoning/planning decision
        from_descs = [facts[s]["description"][:80] for s in it["from"] if s in facts]
        events.append({
            "step": step, "phase": "orient", "type": "plan",
            "intent": it["id"],
            "desc": it["description"],
            "based_on": from_descs,
            "worker": it.get("worker"),
        })
        step += 1

        # If concluded, the resulting fact = a discovery
        if it["to"] and it["to"] in facts:
            to_fact = facts[it["to"]]
            is_flag = bool(FLAG_RE.search(to_fact["description"]))
            events.append({
                "step": step, "phase": "act" if not is_flag else "flag",
                "type": "discovery" if not is_flag else "flag_found",
                "fact": it["to"],
                "desc": to_fact["description"],
                "from_intent": it["id"],
                "worker": it.get("worker"),
            })
            step += 1

    # Completion
    if bb["completed"]:
        events.append({
            "step": step, "phase": "complete", "type": "goal_reached",
            "desc": "Goal achieved — all flags captured.",
        })

    return events


def build_flag_story(bb: dict, code: str) -> dict | None:
    """Build the 'flag discovery story' — the chain from origin to flag.

    Returns a concise narrative showing how the AI went from knowing nothing
    to capturing the flag, suitable for the overview dashboard.
    """
    flags_found = []
    for f in bb["facts"]:
        for m in FLAG_RE.finditer(f["description"]):
            fl = m.group(0)
            if fl.lower() not in ("flag{...}", "flag{probe}") and len(fl) > 12:
                flags_found.append(fl)

    if not flags_found and not bb["completed"]:
        return None

    # Build the chain: walk intents that produced facts
    chain = []
    facts = {f["id"]: f for f in bb["facts"]}
    for it in bb["intents"]:
        if it["to"] and it["to"] in facts:
            to_fact = facts[it["to"]]
            finding_desc = to_fact["description"]
            # Skip the goal template text — show the actual discovery instead
            if to_fact["id"] == "goal":
                # Find the most informative non-origin/goal fact for this chain step
                best = max(
                    (f for f in bb["facts"] if f["id"] not in ("origin", "goal")),
                    key=lambda f: len(f["description"]),
                    default=None,
                )
                if best:
                    finding_desc = best["description"]
            chain.append({
                "action": "explore" if it.get("worker") else "bootstrap",
                "worker": it.get("worker", "bootstrap"),
                "direction": it["description"],
                "finding": finding_desc,
            })

    return {
        "code": code,
        "solved": bb["completed"],
        "flags": list(set(flags_found))[:3],
        "n_facts": len(bb["facts"]),
        "n_intents": len(bb["intents"]),
        "chain": chain[:8],  # cap at 8 steps for readability
    }


def list_run_dbs() -> list[dict]:
    """List all blackboard DBs in solver_runs/, with quick status."""
    results = []
    if not RUNS_DIR.exists():
        return results
    for db in sorted(RUNS_DIR.glob("wormhole-solve-*.db")):
        code = db.stem.replace("wormhole-solve-", "")
        bb = read_blackboard(db)
        # Extract flags
        # Use module-level FLAG_RE (unified with cli_solve)
        flags = set()
        for f in bb["facts"]:
            for m in FLAG_RE.finditer(f["description"]):
                fl = m.group(0)
                if fl.lower() not in ("flag{...}", "flag{probe}") and len(fl) > 12:
                    flags.add(fl)
        results.append({
            "code": code,
            "db": str(db),
            "facts": len(bb["facts"]),
            "intents": len(bb["intents"]),
            "completed": bb["completed"],
            "flags": len(flags),
        })
    return results


# ──────────────────────────────────────────────────────────────
# FastAPI app
# ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Wormhole Web UI started — open http://localhost:8765")
    yield
    # Graceful shutdown: cooperative cancel first, then wait for cleanup.
    # This prevents the orphan-container/slot-leak that happened when the
    # process exited before solve_challenge's finally could release resources.
    if state.task and not state.task.done():
        state.cancel_event.set()
        try:
            await asyncio.wait_for(state.task, timeout=15.0)
        except (asyncio.TimeoutError, Exception):
            state.task.cancel()
            try:
                await state.task
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(title="Wormhole Solver", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    """Serve the single-page dashboard."""
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/api/config")
async def get_config():
    """Return current solver configuration (token masked)."""
    cfg = dict(state.config)
    if cfg.get("token"):
        cfg["token"] = cfg["token"][:8] + "..." + cfg["token"][-4:]
    if cfg.get("anthropic_auth_token"):
        cfg["anthropic_auth_token"] = "***" + cfg["anthropic_auth_token"][-4:]
    cfg["running"] = state.running
    return cfg


@app.post("/api/config")
async def set_config(body: dict):
    """Update solver configuration and persist to disk."""
    for key in ("base_url", "token", "anthropic_auth_token", "anthropic_base_url",
                "anthropic_model", "difficulty", "only"):
        if key in body and body[key]:
            state.config[key] = body[key]
    for key in ("concurrency", "task_timeout", "max_rounds",
                "flag_stagnation_base", "flag_stagnation_per_flag",
                "infra_down_threshold"):
        if key in body and body[key]:
            state.config[key] = int(body[key])
    state._save_config()
    return {"status": "ok"}


@app.get("/api/challenges")
async def challenges():
    """List all challenges from the benchmark platform."""
    if not state.config["base_url"] or not state.config["token"]:
        return JSONResponse({"error": "base_url and token required"}, status_code=400)
    try:
        from wormhole.orchestrator.benchmark_client import BenchmarkClient
        client = BenchmarkClient(state.config["base_url"], state.config["token"])
        data = asyncio.get_event_loop().run_in_executor(None, client.list_challenges)
        result = await data
        return {"challenges": result}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/status")
async def status():
    """Global solver status."""
    dbs = list_run_dbs()
    total_flags = sum(d["flags"] for d in dbs)
    solved = sum(1 for d in dbs if d["completed"])
    return {
        "running": state.running,
        "total_challenges": len(dbs),
        "solved": solved,
        "total_flags": total_flags,
        "outcomes": state.outcomes[-10:],  # last 10
    }


@app.get("/api/blackboard/{code}")
async def blackboard(code: str):
    """Get blackboard data (facts+intents+hints) for a specific challenge."""
    db_path = RUNS_DIR / f"wormhole-solve-{code}.db"
    bb = read_blackboard(db_path)
    # Enrich intents with from-fact descriptions for the thinking-chain DAG
    fact_map = {f["id"]: f["description"] for f in bb["facts"]}
    for it in bb["intents"]:
        it["from_descs"] = [fact_map.get(s, s) for s in it["from"]]
        if it["to"] and it["to"] in fact_map:
            it["to_desc"] = fact_map[it["to"]]
    # Dead-ends: for unsolved challenges, show all attempted facts; for solved,
    # use keyword-based extraction of genuine ruled-out directions.
    has_flags = any(
        m.group(0).lower() not in ("flag{...}", "flag{probe}") and len(m.group(0)) > 12
        for f in bb["facts"] for m in FLAG_RE.finditer(f.get("description", ""))
    )
    if not has_flags:
        bb["dead_ends"] = [
            {"id": f["id"], "description": f["description"]}
            for f in bb["facts"]
            if f["id"] not in ("origin", "goal") and len(f.get("description", "")) >= 20
        ]
    else:
        bb["dead_ends"] = _extract_dead_ends(bb["facts"])
    return bb


@app.get("/api/timeline/{code}")
async def timeline(code: str):
    """Reconstruct the OODA decision timeline for a challenge.

    Returns a chronological event list showing each reasoning step,
    exploration decision, and discovery — the AI's thinking trace.
    """
    db_path = RUNS_DIR / f"wormhole-solve-{code}.db"
    bb = read_blackboard(db_path)
    return {"code": code, "events": build_timeline(bb), "completed": bb["completed"]}


@app.get("/api/live")
async def live():
    """Real-time overview of all active challenges.

    Returns per-challenge: status, fact count, flag count, active peers
    (intents with workers), and the latest fact description. This is the
    primary data source for the dashboard's auto-refresh.
    """
    challenges = []
    for db in sorted(RUNS_DIR.glob("wormhole-solve-*.db")):
        code = db.stem.replace("wormhole-solve-", "")
        bb = read_blackboard(db)
        flags = set()
        for f in bb["facts"]:
            for m in FLAG_RE.finditer(f["description"]):
                fl = m.group(0)
                if fl.lower() not in ("flag{...}", "flag{probe}") and len(fl) > 12:
                    flags.add(fl)
        active_peers = [
            {"worker": it["worker"], "intent": it["id"], "direction": it["description"][:80]}
            for it in bb["intents"] if it.get("worker") and not it.get("to")
        ]
        latest_fact = bb["facts"][-1]["description"] if bb["facts"] else ""
        # Dead-end extraction: for unsolved challenges (no flags), the conclude-
        # fallback facts ARE the "directions tried but failed" — show them
        # directly instead of relying on keyword matching (AI's failure wording
        # is unpredictable: "NOT yet captured", "未捕获", etc).
        if not flags:
            # Unsolved: show all non-origin/goal facts as "attempted directions"
            dead_ends = [
                {"id": f["id"], "description": f["description"]}
                for f in bb["facts"]
                if f["id"] not in ("origin", "goal") and len(f.get("description", "")) >= 20
            ]
        else:
            # Solved: use keyword-based extraction (genuine ruled-out directions)
            dead_ends = _extract_dead_ends(bb["facts"])
        # Determine status: solved / active / stuck / failed / idle
        # "stuck" = has dead ends but no flags and no active peers
        # "failed" = has an outcome error recorded
        outcome = next((o for o in state.outcomes if o.get("unique_code") == code), None)
        stop_reason = outcome.get("error", "") if outcome else ""
        if bb["completed"]:
            status = "solved"
        elif active_peers:
            status = "active"
        elif dead_ends and not flags:
            status = "stuck"
        elif outcome and outcome.get("error"):
            status = "failed"
        else:
            status = "idle"
        challenges.append({
            "code": code,
            "status": status,
            "facts": len(bb["facts"]),
            "intents": len(bb["intents"]),
            "flags": len(flags),
            "completed": bb["completed"],
            "peers": active_peers,
            "latest_fact": latest_fact,
            "dead_ends": dead_ends[:8],
            "stop_reason": stop_reason,
        })
    return {
        "running": state.running,
        "challenges": challenges,
        "total_solved": sum(1 for c in challenges if c["completed"]),
        "total_flags": sum(c["flags"] for c in challenges),
    }


@app.get("/api/overview")
async def overview():
    """Aggregate DAG data across ALL challenges for the overview dashboard.

    Merges every challenge's facts+intents into one big graph so the user
    can see the entire attack surface at a glance. Each node is tagged with
    its originating challenge code.
    """
    all_nodes = []
    all_links = []
    total_flags = 0
    total_solved = 0
    total_facts = 0
    total_intents = 0
    flag_stories = []
    category_stats = defaultdict(lambda: {"solved": 0, "total": 0})

    for db in sorted(RUNS_DIR.glob("wormhole-solve-*.db")):
        code = db.stem.replace("wormhole-solve-", "")
        bb = read_blackboard(db)
        if bb.get("error"):
            continue
        if bb["completed"]:
            total_solved += 1
        total_facts += len(bb["facts"])
        total_intents += len(bb["intents"])

        # Nodes: tag each with challenge code
        for f in bb["facts"]:
            is_flag = bool(FLAG_RE.search(f["description"]))
            if is_flag:
                total_flags += 1
            node_type = "flag" if is_flag else (
                "origin" if f["id"] == "origin" else
                "goal" if f["id"] == "goal" else "fact"
            )
            all_nodes.append({
                "id": f"{code}/{f['id']}",
                "label": f["id"],
                "challenge": code,
                "type": node_type,
                "description": f["description"],
            })

        # Links
        for it in bb["intents"]:
            target = it["to"] or it["id"]
            for src in it["from"]:
                all_links.append({
                    "source": f"{code}/{src}",
                    "target": f"{code}/{target}",
                    "challenge": code,
                    "active": not it["to"] and bool(it.get("worker")),
                })
            if not it["to"]:
                all_nodes.append({
                    "id": f"{code}/{it['id']}",
                    "label": it["id"],
                    "challenge": code,
                    "type": "intent",
                    "description": it["description"],
                })

        # Build flag discovery story for this challenge
        story = build_flag_story(bb, code)
        if story:
            flag_stories.append(story)

        # Category stats (by prefix: a/b/c/d/e1/e2/e3/f1/f2)
        prefix = code.split("-")[0] if "-" in code else code
        cat_map = {"a": "Web", "b": "APT Multi-Flag", "c": "Known Product",
                   "d": "Cloud", "e1": "WAF Bypass", "e2": "Sandbox Escape",
                   "e3": "Evasion", "f1": "Memory Vuln", "f2": "Firmware Rev"}
        cat_name = cat_map.get(prefix, prefix)
        cat = category_stats[cat_name]
        cat["total"] += 1
        cat["prefix"] = prefix
        if bb["completed"]:
            cat["solved"] += 1
        # Count flags and dead ends per category
        ch_flags = sum(1 for f in bb["facts"] if FLAG_RE.search(f["description"]))
        cat["flags"] = cat.get("flags", 0) + len({m.group(0) for f in bb["facts"] for m in FLAG_RE.finditer(f["description"]) if len(m.group(0)) > 12})
        cat["dead_ends"] = cat.get("dead_ends", 0) + len(_extract_dead_ends(bb["facts"]))
        cat["facts"] = cat.get("facts", 0) + len(bb["facts"])

    # Compute success rate per category
    for cat in category_stats.values():
        cat["rate"] = round(cat["solved"] / cat["total"], 2) if cat["total"] else 0

    return {
        "nodes": all_nodes,
        "links": all_links,
        "stats": {
            "solved": total_solved,
            "flags": total_flags,
            "facts": total_facts,
            "intents": total_intents,
            "challenges": len(all_nodes) and len(set(n["challenge"] for n in all_nodes)) or 0,
        },
        "flag_stories": flag_stories,
        "categories": dict(category_stats),
    }



@app.post("/api/start")
async def start_solver():
    """Start the solver in the background."""
    if state.running:
        return JSONResponse({"error": "Solver already running"}, status_code=409)

    cfg = state.config
    if not cfg["base_url"] or not cfg["token"]:
        return JSONResponse({"error": "base_url and token required"}, status_code=400)

    # Set LLM env vars
    if cfg["anthropic_auth_token"]:
        os.environ["ANTHROPIC_AUTH_TOKEN"] = cfg["anthropic_auth_token"]
    if cfg["anthropic_base_url"]:
        os.environ["ANTHROPIC_BASE_URL"] = cfg["anthropic_base_url"]
    if cfg["anthropic_model"]:
        os.environ["ANTHROPIC_MODEL"] = cfg["anthropic_model"]

    # Archive stale blackboard DBs so each run starts fresh but history is
    # preserved for post-mortem / webui display after restart. Replaces the
    # old unlink-all that destroyed the 12000-point run's data.
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    archive_dir = RUNS_DIR / "archive"
    import time as _time
    _ts = _time.strftime("%Y%m%d-%H%M%S")
    archive_dir.mkdir(parents=True, exist_ok=True)
    for old_db in RUNS_DIR.glob("wormhole-solve-*.db*"):
        try:
            dest = archive_dir / f"{old_db.stem}.{_ts}{old_db.suffix}"
            old_db.rename(dest)
        except OSError:
            try:
                old_db.unlink()
            except OSError:
                pass

    async def _run_solver():
        """Background task that runs the solver loop."""
        # Reset the cooperative-cancel signal for this run.
        state.cancel_event = asyncio.Event()
        state.running = True
        state.outcomes.clear()
        await state.broadcast("Solver starting...", "status")

        try:
            from wormhole.solver.cli_solve import (
                load_worker_env, solve_challenge, extract_flags_from_board,
                sort_challenges, Scheduler,
            )
            from wormhole.orchestrator.benchmark_client import BenchmarkClient
            from wormhole.solver.dispatcher import DispatcherConfig
            from wormhole.solver.worker import ClaudeCodeWorker

            worker_env = load_worker_env()
            await state.broadcast(f"LLM: {worker_env.anthropic_model} @ {worker_env.anthropic_base_url}", "status")

            client = BenchmarkClient(cfg["base_url"], cfg["token"])
            challenges = await asyncio.to_thread(client.list_challenges)
            await state.broadcast(f"API returned {len(challenges)} challenges", "status")
            pending = [c for c in challenges if not c.get("is_completed")]
            completed = len(challenges) - len(pending)

            if cfg["difficulty"]:
                pending = [c for c in pending if c.get("difficulty") == cfg["difficulty"]]
            if cfg["only"]:
                only = set(cfg["only"].split())
                pending = [c for c in pending if c.get("unique_code") in only]

            pending = sort_challenges(pending)

            await state.broadcast(f"{len(pending)} challenge(s) to solve "
                                  f"({completed} already completed, "
                                  f"{len(challenges)} total from API)", "status")

            RUNS_DIR.mkdir(parents=True, exist_ok=True)
            image = os.environ.get("SOLVER_IMAGE", "wormhole-solver:latest")
            skills_dir = str(Path(__file__).parent / "skills")

            async def _solve_one(ch, budget=None, attempt=1, allow_hint=False):
                ch_cfg = DispatcherConfig(
                    task_timeout=float(cfg["task_timeout"]),
                    max_rounds=int(cfg["max_rounds"]),
                    health_check=False,
                    flag_stagnation_base=int(cfg.get("flag_stagnation_base", 3)),
                    flag_stagnation_per_flag=int(cfg.get("flag_stagnation_per_flag", 2)),
                    infra_down_threshold=int(cfg.get("infra_down_threshold", 4)),
                )
                if budget and budget > 0:
                    ch_cfg._per_challenge_budget = budget
                return await solve_challenge(
                    client, ch, image=image, worker_env=worker_env,
                    runs_dir=RUNS_DIR, cfg=ch_cfg, log=state.log_callback,
                    skills_dir=skills_dir, attempt=attempt, allow_hint=allow_hint,
                )

            scheduler = Scheduler(
                _solve_one, pending,
                concurrency=int(cfg["concurrency"]), log=state.log_callback,
                cancel_event=state.cancel_event,
                # Platform time window: 360min. Use 350min to leave a safety
                # margin for cleanup. Without this, the scheduler exhausts
                # per-challenge budget (~20min each) in ~3h and idles the rest.
                wall_clock_deadline=time.monotonic() + 350 * 60,
            )
            outcomes = await scheduler.run()

            state.outcomes = outcomes
            total = sum(len(o.get("accepted", [])) for o in outcomes)
            await state.broadcast(f"SOLVE COMPLETE — {total} flags accepted", "status")

        except asyncio.CancelledError:
            await state.broadcast("Solver stopped by user", "status")
        except Exception as exc:
            logger.exception("solver crashed")
            await state.broadcast(f"Solver error: {exc}", "error")
        finally:
            state.running = False
            await state.broadcast("Solver finished", "status")

    state.task = asyncio.create_task(_run_solver())
    return {"status": "started"}


@app.post("/api/stop")
async def stop_solver():
    """Stop the running solver gracefully.

    Two-phase shutdown:
      1. Set the cooperative cancel_event so the Scheduler stops picking up
         NEW challenges. In-flight challenges run to their natural cleanup
         (solve_challenge's finally block releases the platform slot + docker
         container) — this is the safe path that avoids slot leaks.
      2. Wait up to 15s for the task to finish on its own.
      3. If still running, hard-cancel as a last resort (the cancel-safe
         finally in solve_challenge handles cleanup even under CancelledError).
    """
    if not (state.task and not state.task.done()):
        state.running = False
        return {"status": "not running"}
    # Phase 1: cooperative signal
    state.cancel_event.set()
    await state.broadcast("Stop requested — finishing in-flight challenges...", "status")
    # Phase 2: wait for graceful drain
    try:
        await asyncio.wait_for(state.task, timeout=15.0)
    except asyncio.TimeoutError:
        # Phase 3: hard cancel — solve_challenge's cancel-safe finally handles it
        state.task.cancel()
        try:
            await state.task
        except (asyncio.CancelledError, Exception):
            pass
    except Exception:
        pass
    state.running = False
    return {"status": "stopped"}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """WebSocket endpoint for real-time log streaming."""
    await ws.accept()
    state.clients.add(ws)
    try:
        # Send current status on connect
        await ws.send_text(json.dumps({
            "type": "status",
            "msg": f"Connected. Solver {'running' if state.running else 'idle'}.",
        }))
        while True:
            await ws.receive_text()  # keep alive; ignore client messages
    except WebSocketDisconnect:
        state.clients.discard(ws)


# ──────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────

def _port_in_use(port: int) -> bool:
    """Return True if `port` is already bound by some process.

    Prevents the zombie-process bug where a second `python -m wormhole.solver.webui`
    launch silently fails to bind, leaving a process that owns no socket but
    still shows up in tasklist. The user then sees the OLD webui (with stale
    code) and wonders why their fixes don't take effect.
    """
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.bind(("0.0.0.0", port))
            return False
        except OSError:
            return True


def _cleanup_orphans() -> None:
    """Remove leftover solver containers and release platform slots.

    Called at webui startup so that a crash/SIGKILL in the previous session
    doesn't leave the 3-container cap exhausted (which would block all new
    runs). Two phases:
      1. ``docker rm -f`` any ``wormhole-solve-*`` containers.
      2. Call ``BenchmarkClient.close()`` for every challenge whose platform
         slot may still be held.

    Both phases are best-effort and tolerate docker/benchmark being
    unavailable — the webui must still start.
    """
    import subprocess
    # Phase 1: leftover docker containers
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=wormhole-solve-",
             "--format", "{{.Names}}"],
            capture_output=True, text=True, timeout=10,
        )
        names = [n.strip() for n in result.stdout.splitlines() if n.strip()]
        if names:
            print(f"  Startup cleanup: removing {len(names)} orphan container(s): "
                  f"{', '.join(names[:5])}{'…' if len(names) > 5 else ''}")
            for name in names:
                subprocess.run(["docker", "rm", "-f", name],
                               capture_output=True, timeout=30)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        # Docker not installed / daemon down — not fatal, the solver will
        # error loudly when it tries to ensure_container.
        print(f"  Startup cleanup: docker not available ({exc.__class__.__name__}), skipping container cleanup")

    # Phase 2: release any held platform slots
    cfg = state.config
    if not (cfg.get("token") and cfg.get("base_url")):
        return  # no credentials to query the platform
    try:
        from wormhole.orchestrator.benchmark_client import BenchmarkClient
        client = BenchmarkClient(cfg["base_url"], cfg["token"], timeout=10.0)
        challenges = client.list_challenges()
        # Close any challenge that isn't already closed. The platform's
        # container_status field tells us if a slot is held.
        held = [c for c in challenges
                if c.get("container_status") not in ("closed", "idle", "none", None, "")]
        if held:
            print(f"  Startup cleanup: releasing {len(held)} held platform slot(s)")
            for c in held:
                try:
                    client.close(c["unique_code"])
                except Exception:
                    pass
    except Exception as exc:
        # Platform unreachable — not fatal. The solver will report when it
        # actually tries to start a challenge.
        print(f"  Startup cleanup: platform check skipped ({exc.__class__.__name__})")


def main() -> None:
    """Run the web UI server."""
    import uvicorn
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")

    if _port_in_use(8765):
        print(
            "\n!!! Port 8765 is already in use — another webui is likely running.\n"
            "    Either connect to the existing one (http://localhost:8765),\n"
            "    or kill it first:\n"
            "      powershell:  Get-Process python | Where-Object {$_.Path -like '*'} | Stop-Process\n"
            "      git-bash:    taskkill //F //IM python.exe\n"
            "    Exiting to avoid a zombie process.\n"
        )
        sys.exit(1)

    print("\n" + "=" * 50)
    print("  Wormhole Solver Web UI")
    print(f"  Blackboard DBs: {RUNS_DIR}")
    print("  Open: http://localhost:8765")
    print("=" * 50 + "\n")

    # Clean up any orphan containers / held platform slots from a previous
    # crashed session — so start→stop→start always begins from a clean state.
    try:
        _cleanup_orphans()
    except Exception as exc:  # noqa: BLE001 — never block startup on cleanup
        print(f"  Startup cleanup failed (non-fatal): {exc}")

    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
