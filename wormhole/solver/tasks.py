"""Task executors: bootstrap / reason / explore.

Each function wires a blackboard, a worker, and a prompt together:
  1. assemble the prompt (injecting board state)
  2. call the worker (in a thread — claude -p is a blocking subprocess)
  3. parse + validate the JSON the worker returned
  4. write the result back to the board (new fact / new intents / complete)
  5. on timeout or unparseable output, run the conclude fallback: resume the
     same session and ask for a terse summary

Returns a string status: "complete" / "intents" / "fact" / "noop" / "failed"
/ "rejected" — the dispatcher uses these to decide what to do next.
"""
from __future__ import annotations

import asyncio
import logging

from wormhole.solver.blackboard import Blackboard, Intent
from wormhole.solver.contracts import (
    validate_bootstrap_conclude_payload,
    validate_bootstrap_execute_payload,
    validate_explore_payload,
    validate_reason_payload,
)
from wormhole.solver.output_parser import extract_json_object
from wormhole.solver.prompts import (
    format_json,
    inject_graph_reference,
    load_template,
    render,
)
from wormhole.solver.worker import ClaudeCodeWorker, WorkerResult

logger = logging.getLogger(__name__)

# Statuses returned by task executors.
STATUS_COMPLETE = "complete"
STATUS_INTENTS = "intents"
STATUS_FACT = "fact"
STATUS_NOOP = "noop"
STATUS_FAILED = "failed"
STATUS_REJECTED = "rejected"


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #

def _hints_json(bb: Blackboard) -> str:
    """Render hints as JSON for the prompt (or '[]' if none)."""
    return format_json(
        [{"id": h.id, "content": h.content, "creator": h.creator} for h in bb.hints]
    )


def _fact_ids_text(bb: Blackboard) -> str:
    """Valid fact ids (excluding 'goal') that 'complete.from' may reference."""
    ids = [f.id for f in bb.facts if f.id != "goal"]
    return format_json(ids)


def _open_intents_text(bb: Blackboard) -> str:
    """Open intents rendered for the reason prompt."""
    return format_json(
        [
            {"id": it.id, "from": it.from_, "description": it.description, "worker": it.worker}
            for it in bb.open_intents
        ]
    )


async def _try_conclude_fallback(
    worker: ClaudeCodeWorker,
    session: str,
    conclude_prompt: str,
    timeout: float,
    validate_conclude,
) -> tuple[str, str | None]:
    """Resume the session with a conclude prompt; return (status, fact_desc).

    Used when execute timed out or returned unparseable JSON. The conclude
    prompt overrides "keep working" so the model summarizes what it already
    found and stops. Returns ("fact", desc) on success, ("failed", None) if
    even the conclude produces nothing usable.
    """
    try:
        result = await asyncio.to_thread(worker.conclude, conclude_prompt, session, timeout)
    except Exception as exc:  # noqa: BLE001
        logger.warning("conclude fallback crashed: %s", exc)
        return STATUS_FAILED, None

    if not result.ok and not result.timed_out:
        logger.warning("conclude fallback non-zero: %s", result.error)
    desc = _parse_and_validate(result, validate_conclude)
    if desc is None:
        logger.warning("conclude fallback produced no usable fact")
        return STATUS_FAILED, None
    return STATUS_FACT, desc


def _salvage_raw_summary(result: WorkerResult, intent: Intent) -> str | None:
    """Extract a best-effort fact description from unstructured worker output.

    When both the explore execution and the conclude-fallback fail to produce
    a validated JSON fact, the worker's raw stdout often still contains useful
    intelligence: port scan results, discovered endpoints, error messages,
    partial exploit output. This function salvages that content into a fact
    so the DAG has an intermediate node and the next reasoning round can build
    on the findings rather than re-exploring from scratch.
    """
    if not result or not result.stdout:
        return None
    stdout = result.stdout.strip()
    if len(stdout) < 30:
        return None
    # Extract the most information-dense lines (those containing security-
    # relevant keywords), falling back to the first meaningful chunk.
    keywords = (
        "port", "open", "http", "flag", "error", "vuln", "inject", "admin",
        "password", "token", "key", "login", "api", "endpoint", "directory",
        "upload", "shell", "root", "rce", "sql", "xss", "ssrf", "redirect",
        "cookie", "session", "jwt", "encode", "decode", "bypass", "filter",
        "blocked", "refused", "timeout", "unreachable", "403", "401", "500",
        "CVE", "version", "Apache", "nginx", "Python", "PHP", "Java",
        "端口", "开放", "漏洞", "注入", "凭据", "密码", "权限", "绕过",
        "失败", "超时", "拒绝", "可达", "flag", "shell",
    )
    lines = stdout.splitlines()
    dense = [ln.strip() for ln in lines if any(kw.lower() in ln.lower() for kw in keywords)]
    # Take up to 8 dense lines, capped at 600 chars total.
    picked: list[str] = []
    total = 0
    for ln in dense[:12]:
        if total + len(ln) > 600:
            break
        picked.append(ln)
        total += len(ln)
    if not picked:
        # No keyword hits — take the first 3 non-empty lines as fallback.
        picked = [ln.strip() for ln in lines if ln.strip()][:3]
        if not picked:
            return None
    summary = "; ".join(picked)
    tag = "timed out" if result.timed_out else "unvalidated"
    return f"[{intent.id}] Exploration findings ({tag}): {summary}"


def _parse_and_validate(result: WorkerResult, validator) -> str | None:
    """Extract JSON from worker output and run the validator; return fact desc.

    Returns the fact description string on success, or None if the output
    couldn't be parsed/validated (caller triggers conclude fallback).
    """
    if not result.stdout:
        return None
    try:
        payload = extract_json_object(result.stdout)
    except ValueError:
        logger.debug("no JSON in worker output (%d chars)", len(result.stdout))
        return None
    try:
        kind, data = validator(payload)
    except ValueError as exc:
        logger.warning("payload validation failed: %s (payload=%s)", exc, payload)
        return None
    if kind == "rejected":
        logger.warning("worker rejected the task")
        return None
    # All our validators return ("fact", description) for a usable conclude.
    if kind == "fact" and isinstance(data, str):
        return data
    return None


def _build_peer_context(bb: Blackboard, my_name: str, my_intent_id: str) -> str:
    """Build a text block describing what other peers are doing right now.

    Injected into the explore prompt so parallel peers don't duplicate work.
    """
    others = [it for it in bb.open_intents if it.id != my_intent_id and it.worker]
    if not others:
        return "You are the only active agent. No coordination needed."
    lines = [f"You are **{my_name}**. Other agents are currently exploring:"]
    for it in others:
        lines.append(f"- **{it.worker}** on intent {it.id}: {it.description[:100]}")
    lines.append(
        "Avoid overlapping with their directions. If you discover something "
        "they could use, write it to `team/findings/`."
    )
    return "\n".join(lines)


def _sync_progress(bb: Blackboard, worker: ClaudeCodeWorker) -> None:
    """Update PROGRESS.md in the container after new facts are added.

    Best-effort: if the write fails (container down, permissions), we just
    log and continue — the blackboard is the source of truth anyway.
    """
    try:
        from wormhole.solver.cli_solve import _build_progress
        # Find the challenge code from the origin fact
        origin = bb.get_fact("origin")
        code = "unknown"
        if origin and "challenge '" in origin.description:
            import re
            m = re.search(r"challenge '([^']+)'", origin.description)
            if m:
                code = m.group(1)
        worker.write_progress(_build_progress(bb, code))
    except Exception:  # noqa: BLE001 — progress sync is best-effort
        logger.debug("PROGRESS.md sync skipped (non-critical)", exc_info=True)


# --------------------------------------------------------------------------- #
# Bootstrap — the initial direct-solve attempt
# --------------------------------------------------------------------------- #

async def run_bootstrap(
    bb: Blackboard,
    worker: ClaudeCodeWorker,
    timeout: float,
    conclude_timeout: float,
) -> str:
    """Bootstrap: hand the worker origin/goal/hints and let it attempt a solve.

    On success the worker returns ``{fact, complete}``; we record the fact and
    mark the goal complete. On timeout/garbage, we run the conclude fallback
    to salvage at least one fact.
    """
    origin = bb.get_fact("origin")
    goal = bb.get_fact("goal")
    template = load_template("bootstrap")
    prompt = render(template, {
        "origin": origin.description if origin else "",
        "goal": goal.description if goal else "",
        "hints": _hints_json(bb),
    })

    result = await asyncio.to_thread(worker.execute, prompt, timeout)

    # Happy path: parse + validate the execute payload.
    if result.ok or result.timed_out:
        try:
            payload = extract_json_object(result.stdout)
            kind, data = validate_bootstrap_execute_payload(payload)
        except (ValueError, Exception) as exc:  # noqa: BLE001
            logger.info("bootstrap execute unusable (%s) → conclude fallback", exc)
            kind, data = None, None

        if kind == "complete" and data:
            fact_desc = data["fact_description"]
            bb.add_fact(fact_desc)
            bb.complete(data.get("complete", {}).get("from", ["origin"]),
                        data.get("complete_description", fact_desc))
            _sync_progress(bb, worker)
            logger.info("bootstrap: COMPLETE in one shot")
            return STATUS_COMPLETE
        if kind == "rejected":
            return STATUS_REJECTED

    # Fallback: resume the session and ask for a summary fact.
    logger.info("bootstrap: running conclude fallback (session=%s)", result.session)
    conclude_template = load_template("bootstrap_conclude")
    conclude_prompt = render(conclude_template, {
        "origin": origin.description if origin else "",
        "goal": goal.description if goal else "",
        "hints": _hints_json(bb),
    })
    status, desc = await _try_conclude_fallback(
        worker, result.session, conclude_prompt, conclude_timeout,
        validate_bootstrap_conclude_payload,
    )
    if desc:
        bb.add_fact(desc)
    return status


# --------------------------------------------------------------------------- #
# Reason — read the whole graph, decide what's next
# --------------------------------------------------------------------------- #

async def _run_reason_variant(
    bb: Blackboard,
    worker: ClaudeCodeWorker,
    timeout: float,
    max_intents: int,
    *,
    template_name: str,
    creator: str,
    label: str,
) -> str:
    """Shared implementation for run_reason and run_reason_reset.

    The only differences are the prompt template (``reason`` vs ``reason_reset``)
    and the intent creator label. All parsing/validation/logging is identical.
    """
    template = load_template(template_name)
    graph_yaml = bb.export_yaml()
    prompt = await asyncio.to_thread(inject_graph_reference, template, graph_yaml, worker)
    prompt = render(prompt, {
        "fact_ids": _fact_ids_text(bb),
        "open_intents": _open_intents_text(bb),
        "max_intents": str(max_intents),
    })

    result = await asyncio.to_thread(worker.execute, prompt, timeout)
    if not result.ok and not result.timed_out:
        logger.warning("%s: worker error: %s", label, result.error)
        return STATUS_FAILED

    try:
        payload = extract_json_object(result.stdout)
    except ValueError:
        logger.warning("%s: no JSON in output", label)
        return STATUS_FAILED

    try:
        kind, data = validate_reason_payload(
            payload, open_intents_empty=len(bb.open_intents) == 0, max_intents=max_intents
        )
    except ValueError as exc:
        logger.warning("%s: invalid payload: %s", label, exc)
        return STATUS_FAILED

    if kind == "complete" and isinstance(data, dict):
        bb.complete(data.get("from", ["origin"]), data.get("description", ""))
        logger.info("%s: COMPLETE", label)
        return STATUS_COMPLETE
    if kind == "intents" and isinstance(data, list):
        for intent in data:
            bb.create_intent(
                from_ids=intent.get("from", ["origin"]),
                description=intent.get("description", ""),
                creator=creator,
            )
        logger.info("%s: created %d intent(s)", label, len(data))
        return STATUS_INTENTS
    if kind == "rejected":
        return STATUS_REJECTED
    logger.info("%s: noop", label)
    return STATUS_NOOP


async def run_reason(
    bb: Blackboard,
    worker: ClaudeCodeWorker,
    timeout: float,
    max_intents: int,
) -> str:
    """Reason: read the full graph snapshot, decide complete vs new intents."""
    return await _run_reason_variant(
        bb, worker, timeout, max_intents,
        template_name="reason", creator="reason", label="reason",
    )


async def run_reason_reset(
    bb: Blackboard,
    worker: ClaudeCodeWorker,
    timeout: float,
    max_intents: int,
) -> str:
    """Hypothesis-reset variant — demands qualitatively new attack surfaces."""
    return await _run_reason_variant(
        bb, worker, timeout, max_intents,
        template_name="reason_reset", creator="reset", label="reason_reset",
    )


# --------------------------------------------------------------------------- #
# Explore — execute one specific intent
# --------------------------------------------------------------------------- #

async def run_explore(
    bb: Blackboard,
    worker: ClaudeCodeWorker,
    intent: Intent,
    timeout: float,
    conclude_timeout: float,
    worker_name: str = "explore",
) -> str:
    """Explore: claim an intent, execute it, record the finding as a fact.

    Claims the intent (sets worker), runs the worker pointed at the graph +
    the specific intent, then concludes the intent with the discovered fact.
    On timeout/garbage, conclude fallback salvages a summary fact.

    ``worker_name`` is injected into the prompt as the peer identity, and other
    peers' active directions are included so parallel explores don't duplicate.
    """
    bb.claim_intent(intent.id, worker_name)
    bb.heartbeat(intent.id)

    template = load_template("explore")
    graph_yaml = bb.export_yaml()
    prompt = await asyncio.to_thread(inject_graph_reference, template, graph_yaml, worker)

    # Build peer context: what other agents are currently exploring.
    peer_context = _build_peer_context(bb, worker_name, intent.id)

    prompt = render(prompt, {
        "intent_id": intent.id,
        "intent_description": intent.description,
        "peer_context": peer_context,
    })

    result = await asyncio.to_thread(worker.execute, prompt, timeout)

    # Happy path: got a usable fact description.
    if result.ok or result.timed_out:
        desc = _parse_and_validate(result, validate_explore_payload)
        if desc:
            bb.conclude(intent.id, desc)
            _sync_progress(bb, worker)
            logger.info("explore: intent %s → fact", intent.id)
            return STATUS_FACT

    # Fallback: resume session, ask for a summary of what was found.
    logger.info("explore: running conclude fallback for intent %s", intent.id)
    conclude_template = load_template("explore_conclude")
    graph_yaml2 = bb.export_yaml()
    conclude_prompt = await asyncio.to_thread(
        inject_graph_reference, conclude_template, graph_yaml2, worker
    )
    conclude_prompt = render(conclude_prompt, {
        "intent_id": intent.id,
        "intent_description": intent.description,
    })
    status, desc = await _try_conclude_fallback(
        worker, result.session, conclude_prompt, conclude_timeout,
        validate_explore_payload,
    )
    if desc:
        bb.conclude(intent.id, desc)
        _sync_progress(bb, worker)
        logger.info("explore: intent %s → fact (via conclude)", intent.id)
        return STATUS_FACT

    # Both execute and conclude-fallback failed to produce a validated fact.
    # Rather than discarding the entire exploration (which leaves the DAG with
    # no intermediate nodes), salvage a raw summary from the worker's stdout.
    # The worker may have spent minutes discovering ports, endpoints, or error
    # patterns — that intelligence is valuable for the next reasoning round
    # even if it didn't parse into a clean structured fact.
    raw = _salvage_raw_summary(result, intent)
    if raw:
        bb.conclude(intent.id, raw)
        _sync_progress(bb, worker)
        logger.info("explore: intent %s → raw fact (salvaged)", intent.id)
        return STATUS_FACT

    bb.release(intent.id)
    logger.warning("explore: intent %s abandoned (no usable output)", intent.id)
    return status if status else STATUS_FAILED
