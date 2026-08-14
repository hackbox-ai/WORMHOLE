"""Headless CLI: solve benchmark challenges with the Cairn-style solver.

For each challenge:
  1. start the challenge container (via BenchmarkClient) → get target addr
  2. start a worker container (cairn-worker image, with the LLM env injected)
  3. create a blackboard seeded with origin/goal
  4. run the dispatcher OODA loop until complete or deadline
  5. scrape flags out of the blackboard facts and submit them
  6. tear down the worker container + close the challenge

Usage:
    python -m wormhole.solver.cli_solve \\
        --base-url https://bench.example.com \\
        --token <BENCHMARK_TOKEN>

The LLM credentials come from the host's ~/.claude/settings.json (the same
DeepSeek-via-Anthropic config the host claude uses) and are injected into the
worker container as env vars.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from pathlib import Path

from wormhole.orchestrator.benchmark_client import BenchmarkClient, ChallengeError
from wormhole.solver.blackboard import Blackboard
from wormhole.solver.dispatcher import DEFAULT_MAX_ROUNDS, Dispatcher, DispatcherConfig
from wormhole.solver.worker import (
    ClaudeCodeWorker, WorkerEnv,
    make_worker, ensure_container as worker_ensure_container,
    detect_external_ip as worker_detect_external_ip,
    remove_container as worker_remove_container,
)
from wormhole.solver import blackboard as _bb_module

logger = logging.getLogger("wormhole.solve")

from wormhole.solver.constants import FLAG_RE, DEAD_END_PHRASES, POSITIVE_SIGNALS, WorkerConfigError


# --------------------------------------------------------------------------- #
# Challenge scheduling — family/difficulty priority sort (ATX-inspired)
# --------------------------------------------------------------------------- #

# Family priority: cheaper/higher-hit-rate families first.
# c=known products (often easy, default creds), d/e1=cloud/WAF (AI-friendly),
# a/e2=web/sandbox (main flag farm), b=multi-flag APT, e3=evasion, f=pwn/reverse (hardest for LLM).
_FAMILY_ORDER = {"c": 0, "d": 1, "e1": 2, "a": 3, "e2": 4, "b": 5, "e3": 6, "f1": 7, "f2": 8}
_DIFFICULTY_ORDER = {"easy": 0, "medium": 1, "hard": 2}


def _family_key(code: str) -> int:
    """Extract family prefix (a/b/c/d/e1/e2/e3/f1/f2) from a unique_code."""
    for prefix in ("e1", "e2", "e3", "f1", "f2"):
        if code.startswith(prefix + "-"):
            return _FAMILY_ORDER.get(prefix, 9)
    return _FAMILY_ORDER.get(code.split("-")[0], 9)


def sort_challenges(pending: list[dict]) -> list[dict]:
    """Sort challenges by family priority then difficulty.

    This ensures the solver tackles cost-effective challenges first (c→d→e1→a→…)
    and within each family does easy before hard. Inspired by ATX's scheduling
    strategy where c-family (known products) is always picked first because it
    has the highest solve-rate per minute spent.
    """
    return sorted(pending, key=lambda c: (
        _family_key(c.get("unique_code", "")),
        _DIFFICULTY_ORDER.get(c.get("difficulty", "hard"), 2),
    ))


# --------------------------------------------------------------------------- #
# Dynamic scheduler — loss-cut rotation with retry queue (ATX-inspired)
# --------------------------------------------------------------------------- #

# Per-attempt timeout: unified at 10 minutes regardless of difficulty.
# The strategy is "try everything once fast, then revisit failures" —
# this ensures all 74 challenges get attempted before any retry.
# Memory from prior attempts is preserved via experience reuse (prior DB).
_FIRST_WINDOW = 600.0  # 10 minutes per attempt, all difficulties


def _first_window(challenge: dict) -> float:
    """Per-attempt wall-clock budget for the FIRST attempt.

    Unified at 10 minutes for all difficulties. The philosophy is:
    first pass — try every challenge quickly (10min each);
    second pass — revisit unsolved ones with accumulated memory.
    Multi-flag challenges get proportionally more total budget.
    """
    return _FIRST_WINDOW


# Retry attempt multipliers: each retry gets progressively more time so the
# agent can go deeper on hard challenges instead of being cut off mid-exploit.
# attempt 1 = 10min, attempt 2-3 = 15min, attempt 4-5 = 20min, 6+ = 25min.
_RETRY_WINDOW_MULTIPLIERS = {1: 1.0, 2: 1.5, 3: 1.5, 4: 2.0, 5: 2.0}


def _attempt_window(challenge: dict, attempt: int) -> float:
    """Per-attempt timeout, increasing for retries.

    First pass uses the base 10min window for fast coverage. Retries get
    progressively longer windows so the agent has uninterrupted time to
    dig into hard challenges — frequent start/close cycles break the
    agent's chain of thought and waste the container boot overhead.
    """
    base = _first_window(challenge)
    mult = _RETRY_WINDOW_MULTIPLIERS.get(attempt, 2.5)
    return base * mult


class Scheduler:
    """Dynamic challenge scheduler with loss-cut rotation.

    Instead of one-shot gather-all, this maintains a work queue and a retry
    queue. When a slot frees up, it picks the next challenge from the queue.
    Failed/stuck challenges go to retry queue (if they haven't exceeded total
    budget). When the main queue is exhausted, retry queue is served.

    This mirrors ATX's strategy: never let a slot sit idle, rotate stuck
    challenges out quickly, and give easy/cheap families priority.
    """

    def __init__(
        self,
        solve_fn,
        challenges: list[dict],
        *,
        concurrency: int = 3,
        cfg=None,
        log=None,
        cancel_event: asyncio.Event | None = None,
        wall_clock_deadline: float | None = None,
    ) -> None:
        self._solve_fn = solve_fn
        self._concurrency = concurrency
        self._cfg = cfg
        self._log = log or (lambda m: None)
        self._cancel = cancel_event or asyncio.Event()
        # Total time-window deadline (monotonic). When set, the scheduler keeps
        # re-queuing unsolved challenges until the deadline is reached, instead
        # of giving up after per-challenge budget exhaustion. This prevents the
        # "first 3h productive, last 3h idle" failure mode.
        self._wall_deadline = wall_clock_deadline

        # Build sorted work queue
        self._queue = list(challenges)  # already sorted by caller
        self._all_challenges = list(challenges)  # keep full list for re-queue
        self._retry_queue: list[dict] = []
        self._spent: dict[str, float] = {}  # code → total seconds spent so far
        self._attempts: dict[str, int] = {}  # code → number of attempts
        # In wall-clock mode, allow many retries (the deadline is the real cap).
        # Without wall-clock, keep the old 5-attempt cap for backward compat.
        self._max_attempts = 15 if wall_clock_deadline else 5
        # Hint window: only allow hint fetches in the final fraction of the
        # total time budget. Fetching hints too early wastes score on
        # challenges that could have been solved without help. Default: last
        # 1/6 of the window (e.g. last 60 min of a 360 min run).
        if wall_clock_deadline:
            self._hint_window = (wall_clock_deadline - time.monotonic()) / 6
        else:
            self._hint_window = 0  # no wall-clock, no hint gating
        self._first_pass_done = False  # set when main queue exhausted
        self._outcomes: list[dict] = []
        self._lock = asyncio.Lock()

    def _total_budget(self, challenge: dict) -> float:
        """Total time budget across all retries.

        Multi-flag challenges (b-series, 4-6 flags) get more total time
        because each flag may need a separate attempt. The total scales
        with flag_count so a 4-flag challenge can have up to 4 first-windows.
        """
        flag_count = max(int(challenge.get("flag_count", 1)), 1)
        return _first_window(challenge) * flag_count * 2

    def _remaining_budget(self, challenge: dict) -> float:
        code = challenge["unique_code"]
        spent = self._spent.get(code, 0)
        return max(0, self._total_budget(challenge) - spent)

    def _next_challenge(self) -> dict | None:
        """Get the next challenge to run.

        Phase 1: serve main queue (never-tried challenges) to completion.
        Phase 2: serve retry queue (previously failed challenges) in a loop,
                 each getting another 10min attempt with prior memory preserved.
        Phase 3: if retry queue empties but the wall-clock deadline hasn't
                 been reached, re-queue ALL unsolved challenges with refreshed
                 budget and try again. This uses the full time window instead
                 of giving up after 2 attempts per challenge.
        """
        if self._queue:
            return self._queue.pop(0)
        # First pass complete — mark it
        if not self._first_pass_done:
            self._first_pass_done = True
            solved = sum(1 for o in self._outcomes if o.get("solved"))
            total = len(self._outcomes)
            self._log(f"📋 First pass complete: {solved}/{total} solved. "
                      f"Revisiting {len(self._retry_queue)} unsolved challenges...")
        # Retry queue: pick challenges that still have budget or attempts left
        while self._retry_queue:
            ch = self._retry_queue.pop(0)
            code = ch["unique_code"]
            attempts = self._attempts.get(code, 0)
            if attempts >= self._max_attempts:
                self._log(f"[{code}] max attempts ({self._max_attempts}) reached, giving up")
                continue
            # In wall-clock mode, always allow another attempt if time remains.
            # In per-challenge-budget mode, require > 60s remaining.
            if self._wall_deadline:
                if time.monotonic() >= self._wall_deadline:
                    break  # time's up — stop serving
                return ch
            elif self._remaining_budget(ch) > 60:
                return ch

        # Phase 3: retry queue empty. If wall-clock deadline is set and time
        # remains, re-queue all unsolved challenges with refreshed budget.
        if self._wall_deadline and time.monotonic() < self._wall_deadline:
            unsolved_codes = {
                o["unique_code"] for o in self._outcomes if not o.get("solved")
            }
            requeue = [
                ch for ch in self._all_challenges
                if ch["unique_code"] in unsolved_codes
                and self._attempts.get(ch["unique_code"], 0) < self._max_attempts
            ]
            if requeue:
                # Refresh budget so they can run another full first-window
                for ch in requeue:
                    self._spent[ch["unique_code"]] = 0
                self._retry_queue = requeue
                round_num = max(self._attempts.get(ch["unique_code"], 0)
                                for ch in requeue) if requeue else 0
                self._log(f"🔄 Wall-clock requeue: {len(requeue)} unsolved challenges "
                          f"refreshed for round {round_num + 1} "
                          f"({(self._wall_deadline - time.monotonic())/60:.0f}min remaining)")
                # Pop the first one
                return self._retry_queue.pop(0)
        return None

    async def run(self) -> list[dict]:
        """Run the scheduling loop until all challenges are done or cancelled."""
        sem = asyncio.Semaphore(self._concurrency)
        active: set[asyncio.Task] = set()

        async def _worker():
            while not self._cancel.is_set():
                async with sem:
                    ch = await self._maybe_next()
                    if ch is None:
                        break  # no more work
                    code = ch["unique_code"]
                    self._attempts[code] = self._attempts.get(code, 0) + 1
                    start = time.monotonic()
                    self._log(f"[{code}] scheduler: starting attempt {self._attempts[code]} "
                              f"(spent {self._spent.get(code, 0):.0f}s / "
                              f"budget {self._total_budget(ch):.0f}s)")
                    try:
                        # Pass the remaining budget to the solve function so it
                        # can clamp the dispatcher's per-challenge deadline.
                        # This is the CRITICAL wire: without it, the dispatcher
                        # uses its default budget (task_timeout × max_rounds =
                        # 150min) and the challenge runs forever.
                        remaining = self._remaining_budget(ch)
                        # Use progressive window: first pass = 10min, retries
                        # get longer so hard challenges aren't interrupted by
                        # frequent container start/close cycles.
                        window = _attempt_window(ch, self._attempts[code])
                        budget = min(remaining if remaining > 0 else window, window)
                        # Hint gating: only allow hints in the final hint_window
                        # of the total time budget. Before that, challenges must
                        # be solved on their own to maximize score.
                        allow_hint = (
                            self._hint_window > 0
                            and time.monotonic() > self._wall_deadline - self._hint_window
                        )
                        outcome = await self._solve_fn(ch, budget, self._attempts[code], allow_hint)
                    except Exception as exc:
                        self._log(f"[{code}] scheduler: error: {exc}")
                        outcome = {
                            "unique_code": code, "submitted": [], "accepted": [],
                            "correct_flag_count": 0,
                            "total_flag_count": int(ch.get("flag_count", 1)),
                            "solved": False, "error": str(exc),
                        }
                    elapsed = time.monotonic() - start
                    self._spent[code] = self._spent.get(code, 0) + elapsed

                    # Only keep the latest outcome per challenge (overwrite old)
                    self._outcomes = [o for o in self._outcomes if o.get("unique_code") != code]
                    self._outcomes.append(outcome)

                    # Decide: retry or give up?
                    if not outcome.get("solved"):
                        if self._remaining_budget(ch) > 60:
                            self._log(f"[{code}] scheduler: not solved, "
                                      f"queuing for retry "
                                      f"({self._remaining_budget(ch):.0f}s left)")
                            self._retry_queue.append(ch)
                        else:
                            self._log(f"[{code}] scheduler: giving up "
                                      f"(budget exhausted)")

            self._log("scheduler: worker done")

        # Launch concurrent workers
        workers = [asyncio.create_task(_worker()) for _ in range(self._concurrency)]
        await asyncio.gather(*workers, return_exceptions=True)
        return self._outcomes

    async def _maybe_next(self) -> dict | None:
        """Thread-safe next-challenge fetch."""
        async with self._lock:
            return self._next_challenge()


# --------------------------------------------------------------------------- #
# LLM env discovery (host → container)
# --------------------------------------------------------------------------- #

def load_worker_env() -> WorkerEnv:
    """Read the LLM endpoint config from ~/.claude/settings.json.

    Falls back to env vars (ANTHROPIC_*) if the settings file is absent, so the
    solver also works in containers/CI where settings.json isn't present.
    """
    settings_path = Path.home() / ".claude" / "settings.json"
    env_data: dict[str, str] = {}
    if settings_path.exists():
        try:
            raw = json.loads(settings_path.read_text(encoding="utf-8"))
            env_data = {k: str(v) for k, v in (raw.get("env") or {}).items()}
        except (OSError, ValueError):
            logger.warning("could not parse %s; falling back to env vars", settings_path)

    token = (
        os.environ.get("ANTHROPIC_AUTH_TOKEN")
        or os.environ.get("ANTHROPIC_API_KEY")
        or env_data.get("ANTHROPIC_AUTH_TOKEN")
        or ""
    )
    if not token:
        # Raise (don't sys.exit) so library callers (webui) can catch via
        # ``except Exception``. SystemExit inherits from BaseException and
        # would kill the whole webui process silently.
        raise WorkerConfigError(
            "no ANTHROPIC_AUTH_TOKEN found. Put it in "
            "~/.claude/settings.json (env.ANTHROPIC_AUTH_TOKEN) or export it."
        )

    return WorkerEnv(
        anthropic_base_url=(
            os.environ.get("ANTHROPIC_BASE_URL")
            or env_data.get("ANTHROPIC_BASE_URL")
            or "https://open.bigmodel.cn/api/anthropic"
        ),
        anthropic_auth_token=token,
        anthropic_model=(
            os.environ.get("ANTHROPIC_MODEL")
            or env_data.get("ANTHROPIC_MODEL")
            or "glm-5.2"
        ),
        extra={
            k: v for k, v in env_data.items()
            if k.startswith("ANTHROPIC_") and k not in {
                "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"
            }
        },
    )


# --------------------------------------------------------------------------- #
# Experience reuse — extract findings from prior runs (ATX-inspired)
# --------------------------------------------------------------------------- #

# Dead-end markers now imported from constants (shared with webui).
_DEAD_END_MARKERS = DEAD_END_PHRASES


def _archive_old_db(bb_path: Path) -> None:
    """Move a stale blackboard DB (and its WAL/SHM sidecars) into runs_dir/archive/.

    Replaces the old ``bb_path.unlink()`` which destroyed history with no
    recovery. Archiving preserves the full exploration trace so:
      - webui can still show past runs after a restart
      - _extract_prior_experience can read richer context
      - post-mortem debugging is possible

    The archived file is renamed with a timestamp suffix. ``OSError`` (file
    locked on Windows, disk full) is tolerated — we fall back to unlink so
    the new run can still proceed with a clean DB.
    """
    if not bb_path.exists():
        return
    archive_dir = bb_path.parent / "archive"
    try:
        archive_dir.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        # Move the main DB + WAL/SHM sidecars
        for p in [bb_path] + [
            bb_path.with_suffix(bb_path.suffix + s) for s in ("-wal", "-shm")
        ]:
            if p.exists():
                dest = archive_dir / f"{p.stem}.{ts}{p.suffix}"
                try:
                    p.rename(dest)
                except OSError:
                    # Cross-device or locked — fall back to deletion so the
                    # new run isn't blocked by a stale DB.
                    try:
                        p.unlink()
                    except OSError:
                        pass
    except OSError:
        # archive dir creation failed — fall back to unlink
        try:
            bb_path.unlink()
        except OSError:
            pass


def _extract_prior_experience(runs_dir: Path, code: str) -> str | None:
    """Extract reusable findings from a previous run's blackboard.

    Looks for `wormhole-solve-{code}*.db` files in runs_dir that were NOT
    just created by the current run (heuristic: file is older than 5 seconds).
    From the most recent prior DB, extracts:
      - Confirmed findings (credentials, endpoints, vulns) — short summaries
      - Dead-end conclusions ("X doesn't work, skip")

    Returns a text block to inject into the origin prompt, or None if no
    prior data found. The block is address-independent (no old IPs/URLs).
    """
    import sqlite3

    # Find prior DBs for this challenge (any that aren't the current one).
    # The current run's DB is created AFTER this function returns, so any
    # existing DB is from a previous run.
    prior_dbs = sorted(
        runs_dir.glob(f"wormhole-solve-{code}*.db"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not prior_dbs:
        return None

    db_path = prior_dbs[0]
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        facts = conn.execute(
            "SELECT id, description FROM facts WHERE id NOT IN ('origin','goal') ORDER BY id"
        ).fetchall()
        conn.close()
    except Exception:
        return None

    if not facts:
        return None

    findings = []
    dead_ends = []
    for fid, desc in facts:
        if not desc or len(desc) < 20:
            continue
        lower = desc.lower()
        # Strong positive signal (flag, RCE confirmed, ...) → confirmed finding.
        has_strong_positive = any(sig in lower for sig in POSITIVE_SIGNALS)
        is_dead_end = not has_strong_positive and any(m in lower for m in _DEAD_END_MARKERS)
        # Strip old IP addresses / container addrs (address-independent reuse)
        clean = desc[:150]
        if is_dead_end:
            dead_ends.append(f"- [{fid}] {clean}")
        else:
            findings.append(f"- [{fid}] {clean}")

    if not findings and not dead_ends:
        return None

    lines = []
    if findings:
        lines.append("### Confirmed Findings (reuse these, don't rediscover):")
        lines.extend(findings[:8])
    if dead_ends:
        lines.append("\n### Dead Ends (already ruled out, skip these):")
        lines.extend(dead_ends[:6])
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Flag extraction from the blackboard
# --------------------------------------------------------------------------- #

def extract_flags_from_board(bb: Blackboard) -> list[str]:
    """Grep every fact description for flag{...}. De-dup, preserve order.

    Excludes the literal placeholder ``flag{...}`` (used in prompt templates
    and goal descriptions as an example shape, not a real flag).
    """
    flags: list[str] = []
    seen: set[str] = set()
    for fact in bb.facts:
        for match in FLAG_RE.finditer(fact.description):
            flag = match.group(0)
            # Skip the literal placeholder "flag{...}" that appears in prompts.
            if flag.lower() == "flag{...}":
                continue
            if flag not in seen:
                seen.add(flag)
                flags.append(flag)
    return flags


def _flagstate_path(runs_dir: Path, container_name: str) -> Path:
    """Persistent submitted/rejected flag record for one challenge.

    Survives across retry attempts so that (a) a flag submitted once is never
    re-submitted (idempotency across attempts), and (b) a flag the platform
    REJECTED — typically because the target rotated and the value changed — is
    remembered as invalid. The dispatcher receives the rejected set as
    ``invalid_flags`` and excludes it from the "found enough flags?" gate,
    which kills the rounds=0 false-goal-reached bug on env rotation.
    """
    return runs_dir / f"{container_name}.flagstate.json"


def _load_flagstate(path: Path) -> tuple[set[str], set[str]]:
    """Return (submitted, rejected). Missing/corrupt file → empty sets."""
    if not path.exists():
        return set(), set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return set(data.get("submitted", [])), set(data.get("rejected", []))
    except Exception:  # noqa: BLE001
        return set(), set()


def _save_flagstate(path: Path, submitted: set[str], rejected: set[str]) -> None:
    """Best-effort persist. A lost write only causes a redundant re-submit later."""
    try:
        path.write_text(
            json.dumps(
                {"submitted": sorted(submitted), "rejected": sorted(rejected)}
            ),
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------------------- #
# Per-challenge solve
# --------------------------------------------------------------------------- #

# Level-specific strategy hints (mirrors the image's CLAUDE.md, but injected
# explicitly so the worker gets targeted guidance even if CLAUDE.md's level
# mapping doesn't match the benchmark's exact numbering).
_LEVEL_STRATEGIES = {
    1: (
        "Level 1 — SRC / web vuln discovery. Do broad recon first: port scan, "
        "directory brute (ffuf/gobuster), nuclei templates, sitemap/robots. "
        "Check common web flaws: SQLi, XSS, SSRF, IDOR, file upload, LFI/RFI, "
        "default creds. Work hypothesis-first: enumerate broadly, then verify "
        "one hypothesis at a time."
    ),
    2: (
        "Level 2 — CVE / cloud / AI-infra exploits. Identify software + version "
        "(headers, /actuator, favicon hash, login pages), then look up known "
        "CVEs. PoC repos: /home/kali/pocs (Awesome-POC, CVE-PoC, exphub, "
        "vulhub), /home/kali/knowledges (PayloadsAllTheThings, hacktricks, "
        "hacktricks-cloud). nuclei templates: /home/kali/.local/nuclei-templates."
    ),
    3: (
        "Level 3 — multi-stage / lateral movement. After the initial foothold "
        "(web shell / RCE), enumerate the internal network (nmap -sn, "
        "arp-scan), pivot with chisel/proxychains, harvest creds, and chain "
        "across hosts. Persist access (web shell, SSH key, cron). The flag may "
        "be on an internal host reachable only after pivoting."
    ),
    4: (
        "Level 4 — Active Directory / domain pen-test. Tools: impacket-* "
        "(/usr/bin/impacket-smbclient, -psexec, -secretsdump, -wmiexec), "
        "netexec/nxc, evil-winrm. Workflow: enumerate (users/shares/SMB "
        "null-session) → AS-REP roasting / Kerberoasting (hashcat -m 18200) → "
        "credential reuse → DCSync (secretsdump) → lateral move → flag on DC."
    ),
}


def _build_origin(
    code: str,
    desc: str,
    target: str,
    level,
    flag_count: int,
    ext_ip: str | None,
) -> str:
    """Assemble the origin fact with full environment context.

    This is what the worker sees at bootstrap — it's the single most important
    lever for steering the worker toward the right toolset per challenge type.
    """
    parts = [f"CTF challenge '{code}'. {desc}"]
    parts.append(f"\nTarget: {target} (reachable via the host VPN).")

    # Environment self-description — the worker is inside a Kali container.
    parts.append(
        "\n## Your environment\n"
        "You are inside a Kali Linux container with full security tooling. "
        "Key tools on PATH: nmap, sqlmap, nuclei, ffuf, gobuster, masscan, "
        "hydra, john, hashcat, impacket-* (smbclient/psexec/secretsdump/"
        "wmiexec), netexec/nxc, evil-winrm, proxychains, gdb. Python libs: "
        "pwntools, impacket, scapy, capstone, unicorn, requests, paramiko."
    )
    parts.append(
        "PoC & knowledge repos inside the container:\n"
        "  /home/kali/pocs — Awesome-POC, CVE-PoC, exphub, vulhub\n"
        "  /home/kali/knowledges — PayloadsAllTheThings, InternalAllTheThings, "
        "hacktricks, hacktricks-cloud\n"
        "  /home/kali/.local/nuclei-templates — nuclei detection templates\n"
        "  /home/kali/tools — jwt_tool, ysoserial.jar and others"
    )

    # External IP — critical for reverse shells / OOB data exfil / XSS receive.
    if ext_ip:
        parts.append(
            f"\n## Your external IP (for callbacks): {ext_ip}\n"
            f"Any port you listen on in this container is reachable from the "
            f"target via this IP. Use it for: reverse shells (nc listener), "
            f"OOB DNS/HTTP exfiltration, SSRF callback targets, XSS data "
            f"receivers, XXE external-entity endpoints. Example:\n"
            f"  nc -lvnp 4444   # then trigger target to connect back to {ext_ip}:4444"
        )
    else:
        parts.append(
            "\n## Callback IP: unknown (probe failed)\n"
            "If a challenge needs a reverse shell or OOB callback, run "
            "`curl -s https://api.ipify.org` from inside the container to "
            "discover your external IP first."
        )

    # Level-specific strategy.
    if level is not None and int(level) in _LEVEL_STRATEGIES:
        parts.append(f"\n## Strategy hint (level {level})\n{_LEVEL_STRATEGIES[int(level)]}")
    else:
        parts.append(
            "\n## Strategy hint\n"
            "Start with recon (nmap port scan + service identification), then "
            "branch based on what you find. For web apps, work "
            "hypothesis-first: enumerate the attack surface, then verify one "
            "hypothesis at a time."
        )

    # Collaboration instructions (Slopper-style peer coordination).
    parts.append(
        "\n## Collaboration\n"
        "You may be working in parallel with other agents on this challenge. "
        "Shared files in the workspace:\n"
        "- `PROGRESS.md` — read this first; it lists all confirmed findings "
        "and what other agents are currently exploring.\n"
        "- `team/findings/` — validated findings and reusable scripts from "
        "other agents. Check here before spending time rediscovering something.\n"
        "- `team/notes/` — write your current direction here so others don't "
        "duplicate your work.\n"
        "If you find a vulnerability or useful credential, write it to "
        "`team/findings/` so parallel agents can build on it."
    )

    return "\n".join(parts)


def _build_progress(bb: Blackboard, code: str) -> str:
    """Generate PROGRESS.md content from the current blackboard state.

    Written to the worker container's workspace so parallel explore peers
    can read each other's findings before starting their own work.
    """
    lines = [f"# Wormhole Progress — {code}", ""]
    lines.append(f"## Facts ({len(bb.facts)})")
    for f in bb.facts:
        if f.id in ("origin", "goal"):
            continue
        lines.append(f"- **{f.id}**: {f.description[:150]}")
    open_intents = bb.open_intents
    lines.append(f"\n## Open Intents ({len(open_intents)})")
    for it in open_intents:
        worker = it.worker or "unclaimed"
        lines.append(f"- **{it.id}** ({worker}): {it.description[:100]}")
    lines.append("\n## Collaboration")
    lines.append("- Read this file before starting work to see what others found.")
    lines.append("- Write validated findings to `team/findings/` for reuse.")
    lines.append("- Write your current direction to `team/notes/`.")
    return "\n".join(lines)


def _build_goal(flag_count: int) -> str:
    """The goal fact — what 'done' means, with anti-premature-exit discipline.

    This is read by reason at every planning step and by bootstrap at the
    initial attempt. The wording is deliberately forceful about not stopping
    early, because the #1 failure mode on multi-flag challenges is the worker
    declaring victory after the first flag.
    """
    if flag_count <= 1:
        return (
            "Capture the flag on this target. It looks like flag{...} (any "
            "case). Record it verbatim in a fact description. Only declare "
            "the goal complete once you have the EXACT flag string in hand."
        )
    return (
        f"Capture ALL {flag_count} flags on this target. Flags look like "
        f"flag{{...}} (any case: flag{{}} FLAG{{}} Flag{{}}). Each flag you "
        f"confirm MUST be recorded verbatim in a SEPARATE fact description.\n\n"
        f"CRITICAL DISCIPLINE:\n"
        f"- Do NOT declare the goal complete until you have found all {flag_count} "
        f"flags. Finding 1 of {flag_count} is NOT completion.\n"
        f"- After finding a flag, immediately ask: where are the other "
        f"{flag_count - 1}? Keep exploring.\n"
        f"- Flags hide in many places: DB rows, files, env vars, response "
        f"headers, command output, other endpoints, other ports, other hosts "
        f"after pivoting. Exhaust each before concluding a flag doesn't exist.\n"
        f"- If you are stuck on remaining flags, propose a new exploration "
        f"direction rather than declaring completion."
    )

async def solve_challenge(
    client: BenchmarkClient,
    challenge: dict,
    *,
    image: str,
    worker_env: WorkerEnv,
    runs_dir: Path,
    cfg: DispatcherConfig,
    log,
    skills_dir: str | None = None,
    attempt: int = 1,
    allow_hint: bool = False,
) -> dict:
    """Run the full start → solve → submit → close cycle for one challenge."""
    code = challenge["unique_code"]
    flag_count = int(challenge.get("flag_count", 1))
    outcome = {
        "unique_code": code,
        "submitted": [],
        "accepted": [],
        "correct_flag_count": int(challenge.get("correct_flag_count", 0)),
        "total_flag_count": flag_count,
        "solved": False,
        "error": None,
    }

    if challenge.get("is_completed"):
        log(f"[{code}] already completed, skipping")
        outcome["solved"] = True
        return outcome

    # Start the challenge container.
    try:
        addrs = await asyncio.to_thread(client.start, code)
        if not addrs:
            outcome["error"] = "start returned no container_addr"
            log(f"[{code}] {outcome['error']}")
            return outcome
    except ChallengeError as exc:
        outcome["error"] = f"start: {exc}"
        log(f"[{code}] {outcome['error']}")
        return outcome

    target = addrs[0]
    log(f"[{code}] target = {target}")

    # Start the worker container FIRST so we can probe its outbound IP.
    container_name = f"wormhole-solve-{re.sub(r'[^a-zA-Z0-9_.-]', '_', code)}"[:63]
    try:
        worker_ensure_container(
            container_name, image, worker_env, skills_dir=skills_dir
        )
    except RuntimeError as exc:
        outcome["error"] = str(exc)
        log(f"[{code}] {outcome['error']}")
        # CRITICAL: release the platform challenge slot that client.start()
        # already claimed. Without this, the slot leaks — the platform counts
        # it as "active" and it blocks the 3-container concurrency limit.
        try:
            await asyncio.to_thread(client.close, code)
        except Exception:
            pass
        return outcome

    # Probe the container's public IP (for reverse-shell / OOB-exfil callbacks).
    # The image's CLAUDE.md leaves this as "未填写"; we fill it dynamically.
    ext_ip = await asyncio.to_thread(worker_detect_external_ip, container_name)
    if ext_ip:
        log(f"[{code}] external IP (for callbacks): {ext_ip}")

    # Build origin/goal for the blackboard, enriched with environment context.
    desc = challenge.get("description") or ""
    level = challenge.get("level")
    origin = _build_origin(code, desc, target, level, flag_count, ext_ip)
    goal = _build_goal(flag_count)

    # Experience reuse: if a previous run of this challenge left a blackboard
    # DB, extract confirmed findings and dead-end conclusions from it, then
    # inject as a "prior experience" section in the origin prompt. This lets
    # retries skip already-explored dead ends and build on confirmed leads —
    # mirroring ATX's experience-reuse agent (without a separate agent).
    reuse_block = _extract_prior_experience(runs_dir, code)
    if reuse_block:
        origin += f"\n\n## Prior Experience (from previous run)\n{reuse_block}"
        log(f"[{code}] injected prior experience into origin prompt")

    # Hint injection: only in the final phase of the total time budget, and
    # only on retry attempts. Hints cost score (reduced by hint_cost_ratio),
    # so they must not be fetched prematurely. The Scheduler gates this via
    # allow_hint, which becomes True only when the remaining wall-clock time
    # falls below the hint window (default: last 1/6 of total budget).
    if attempt >= 2 and allow_hint:
        try:
            hint_text = await asyncio.to_thread(client.hint, code)
            if hint_text and hint_text.strip():
                origin += f"\n\n## Official Hint (from platform)\n{hint_text.strip()}"
                log(f"[{code}] 💡 hint injected (attempt {attempt}, final phase)")
        except Exception as exc:  # noqa: BLE001
            log(f"[{code}] hint fetch failed: {exc}")

    bb_path = runs_dir / f"{container_name}.db"
    bb: Blackboard | None = None
    try:
        if attempt >= 2 and bb_path.exists():
            # RETRY: preserve the existing blackboard graph so the agent
            # inherits ALL prior facts, dead-end annotations, and intent
            # history. This is the core of the accumulative-cognition design:
            # each retry continues on the full knowledge graph, not a blank
            # slate. The agent sees prior dead-ends in the exported YAML and
            # avoids retried directions, while building on confirmed findings.
            bb = Blackboard(bb_path)
            prior_facts = len(bb.facts)
            prior_intents = len(bb.all_intents)
            # Record the new target for this attempt (container may have been
            # redeployed with a different IP). Added as a new fact, not by
            # rewriting origin — the graph's history is append-only.
            bb.add_fact(
                f"[Attempt {attempt}] Target: {target}. "
                f"Continuing with {prior_facts} facts and {prior_intents} intents "
                f"from prior attempts."
            )
            log(f"[{code}] retry: inherited {prior_facts} facts, "
                f"{prior_intents} intents from prior graph")
        else:
            # FIRST ATTEMPT (or no prior DB): fresh blackboard.
            # Archive any stale DB from a much older run (different token /
            # different deployment) to avoid IP confusion.
            _archive_old_db(bb_path)
            bb = Blackboard(bb_path)
            bb.create_project(origin, goal)

        worker = make_worker(container_name)
        # Set up Slopper-style collaboration dirs so parallel explore peers
        # can share findings via files (team/notes, team/findings, PROGRESS.md).
        worker.setup_team_dirs()
        worker.write_progress(_build_progress(bb, code))

        # Real-time flag submission: each flag is submitted the moment it
        # appears in a fact, not after the entire solve finishes. This
        # protects multi-flag challenges (B-series: 4 flags) from losing
        # already-found flags if the solve exits early (budget, infra-down,
        # stagnation). The submit HTTP call is dispatched to a worker thread
        # so it does NOT block the dispatcher's asyncio event loop (which
        # would stall all concurrent challenges for up to 30s per submit).
        # Cross-attempt flag submission state: a flag submitted (or rejected)
        # on a prior attempt is remembered so we don't re-submit it every retry,
        # and platform-rejected flags become the dispatcher's invalid_flags
        # (kills the rounds=0 false-goal-reached bug when env rotation makes
        # inherited graph flags stale).
        _fs_path = _flagstate_path(runs_dir, container_name)
        _submitted_state, _rejected_state = _load_flagstate(_fs_path)
        already_submitted: set[str] = set(_submitted_state)
        if _rejected_state:
            log(f"[{code}] {len(_rejected_state)} flag(s) rejected on prior "
                f"attempt(s) — marked invalid (likely env rotation)")
        _in_flight: set[str] = set()  # flags currently being submitted async
        _submit_loop: asyncio.AbstractEventLoop = asyncio.get_event_loop()

        def _do_submit(flag: str) -> None:
            """Sync worker: runs in a thread, updates shared outcome state."""
            try:
                verdict = client.submit(code, flag)
                # Only mark as submitted AFTER success — if submit throws
                # (network error), the flag stays eligible for batch retry.
                already_submitted.add(flag)
                _submitted_state.add(flag)
                outcome["submitted"].append(flag)
                if verdict.get("correct"):
                    outcome["accepted"].append(flag)
                    outcome["correct_flag_count"] = int(
                        verdict.get("correct_flag_count", outcome["correct_flag_count"])
                    )
                    outcome["total_flag_count"] = int(
                        verdict.get("total_flag_count", outcome["total_flag_count"])
                    )
                    log(f"[{code}] ✅ accepted (real-time): {flag}")
                else:
                    # Platform says wrong — almost always env rotation (the
                    # flag value changed with the container). Remember it as
                    # invalid so future attempts + the dispatcher skip it.
                    _rejected_state.add(flag)
                    log(f"[{code}] ❌ rejected (real-time): {flag}")
            except ChallengeError as exc:
                if exc.is_duplicate():
                    already_submitted.add(flag)
                    _submitted_state.add(flag)
                    outcome["accepted"].append(flag)
                    log(f"[{code}] = duplicate (already submitted): {flag}")
                else:
                    log(f"[{code}] submit error ({exc.code}): {exc}")
            except Exception as exc:  # noqa: BLE001
                log(f"[{code}] submit error: {exc}")
            finally:
                _in_flight.discard(flag)
                _save_flagstate(_fs_path, _submitted_state, _rejected_state)

        def _on_flag_found(flag: str) -> None:
            if flag in already_submitted or flag in _in_flight:
                return
            _in_flight.add(flag)
            # Dispatch to a thread — returns immediately, does not block the
            # event loop. Result updates shared outcome/already_submitted.
            _submit_loop.run_in_executor(None, _do_submit, flag)

        dispatcher = Dispatcher(
            bb, worker, cfg,
            log=lambda m: log(f"[{code}] {m}"),
            target_flag_count=flag_count,
            on_flag_found=_on_flag_found,
            invalid_flags=_rejected_state,
        )

        # Per-challenge wall-clock budget (absolute monotonic deadline).
        per_challenge_budget = getattr(
            cfg, "_per_challenge_budget", cfg.task_timeout * cfg.max_rounds
        )
        deadline = time.monotonic() + per_challenge_budget

        result = await dispatcher.solve(deadline=deadline)
        log(f"[{code}] dispatcher: {result.rounds} rounds, "
            f"+{result.facts_added} facts, completed={result.completed} "
            f"(stop={result.stop_reason})")

        # Final batch submit — catches any flags the real-time callback
        # missed (e.g. flags discovered in the very last conclude-fallback
        # that didn't trigger a stagnation check). Already-submitted flags
        # are skipped via the ``already_submitted`` set.
        flags = extract_flags_from_board(bb)
        new_flags = [f for f in flags if f not in already_submitted]
        if new_flags:
            log(f"[{code}] batch submit: {len(new_flags)} new flag(s) "
                f"({len(flags) - len(new_flags)} already submitted in real-time)")
        for flag in new_flags:
            try:
                verdict = await asyncio.to_thread(client.submit, code, flag)
                already_submitted.add(flag)
                _submitted_state.add(flag)
                outcome["submitted"].append(flag)
                if verdict.get("correct"):
                    outcome["accepted"].append(flag)
                    outcome["correct_flag_count"] = int(
                        verdict.get("correct_flag_count", outcome["correct_flag_count"])
                    )
                    outcome["total_flag_count"] = int(
                        verdict.get("total_flag_count", outcome["total_flag_count"])
                    )
                    log(f"[{code}] ✅ accepted: {flag}")
                else:
                    _rejected_state.add(flag)
                    log(f"[{code}] ❌ rejected: {flag}")
            except ChallengeError as exc:
                if exc.is_duplicate():
                    _submitted_state.add(flag)
                    outcome["accepted"].append(flag)
                    log(f"[{code}] = duplicate (already submitted): {flag}")
                else:
                    log(f"[{code}] submit error ({exc.code}): {exc}")
        _save_flagstate(_fs_path, _submitted_state, _rejected_state)
    except Exception as exc:  # noqa: BLE001
        outcome["error"] = f"solve: {exc}"
        logger.exception("[%s] solve failed", code)
        log(f"[{code}] ERROR: {exc}")
    finally:
        # Cleanup must be CANCEL-SAFE: if the parent task was cancelled
        # (webui /api/stop, lifespan shutdown), a bare CancelledError would
        # interrupt the `await asyncio.to_thread(client.close, code)` below
        # and leak the platform slot — the root cause of the "6 orphan
        # containers" incident. We shield the cleanup so it completes even
        # under cancellation, then re-raise CancelledError to propagate.
        cancelled = False
        try:
            if bb is not None:
                bb.close()
            worker_remove_container(container_name)
            # client.close is the critical slot-releaser; shield it so a
            # concurrent CancelledError can't abort the HTTP call.
            await asyncio.shield(asyncio.to_thread(client.close, code))
        except asyncio.CancelledError:
            cancelled = True
            # Best-effort: client.close may not have completed. Retry without
            # await (sync, in this thread) as a last attempt. client.close
            # catches its own ChallengeError, so this won't raise.
            try:
                client.close(code)
            except Exception:  # noqa: BLE001
                pass
        if cancelled:
            raise asyncio.CancelledError()

    outcome["solved"] = outcome["correct_flag_count"] >= outcome["total_flag_count"]
    return outcome


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wormhole-solve",
        description="Solve TSec Benchmark challenges with the Cairn-style solver (headless).",
    )
    p.add_argument("--base-url", default=os.environ.get("BENCHMARK_BASE_URL"))
    p.add_argument("--token", default=os.environ.get("BENCHMARK_TOKEN"))
    p.add_argument("--image", default=os.environ.get("SOLVER_IMAGE", "wormhole-solver:latest"))
    p.add_argument("--concurrency", type=int, default=3,
                   help="Concurrent challenges — platform allows max 3 active containers.")
    p.add_argument("--task-timeout", type=float, default=600.0,
                   help="Per-explore/reason wall-clock seconds (10 min default). "
                        "Bootstrap uses --bootstrap-timeout (20 min) instead. "
                        "Lowering this makes stuck challenges iterate faster: "
                        "3 rounds × 10min = 30min before flag-stagnation fires, "
                        "vs 3 × 20min = 60min with the old default.")
    p.add_argument("--bootstrap-timeout", type=float, default=1200.0,
                   help="Bootstrap full-attempt timeout (20 min).")
    p.add_argument("--max-rounds", type=int, default=DEFAULT_MAX_ROUNDS,
                   help="Max dispatcher rounds per challenge.")
    p.add_argument("--per-challenge-budget", type=float, default=2700.0,
                   help="Per-challenge total wall-clock budget (45 min default). "
                        "This is now a HARD wall — explore/reason timeouts are "
                        "clamped to the remaining budget, so a 20-minute explore "
                        "can no longer blow past it. Flag-aware stagnation "
                        "(--flag-stagnation-base) usually fires well before this.")
    p.add_argument("--max-intents", type=int, default=3,
                   help="Max new intents one reason round may create.")
    p.add_argument("--max-parallel-explores", type=int, default=3,
                   help="Max concurrent explores within one challenge (each is a "
                        "separate claude -p call sharing the container).")
    p.add_argument("--flag-stagnation-base", type=int, default=3,
                   help="Stop after this many rounds with NO new flag (when 0 "
                        "flags found). The primary anti-waste gate — prevents "
                        "burning tokens circling dead ends. Set higher for more "
                        "patience on hard challenges.")
    p.add_argument("--flag-stagnation-per-flag", type=int, default=2,
                   help="Extra stagnation tolerance per flag already found. With "
                        "base=3/per_flag=2: 0 flags → stop after 3 barren rounds; "
                        "2 flags → stop after 7 barren rounds (multi-flag patience).")
    p.add_argument("--infra-down-threshold", type=int, default=4,
                   help="Stop a challenge early when this many recent explore "
                        "facts ALL report the target unreachable (0 disables). "
                        "Saves budget on dead containers — we saw 3 challenges "
                        "burn ~7h on dead targets in the 9100-point run.")
    p.add_argument("--no-reset", action="store_true",
                   help="Disable the hypothesis-reset reason turn that fires "
                        "once before stagnation gives up. Useful for A/B testing.")
    p.add_argument("--no-health-check", action="store_true",
                   help="Disable the LLM-endpoint health probe (skip startup + "
                        "backoff; faster but may waste time on a dead endpoint).")
    p.add_argument("--difficulty", choices=["easy", "medium", "hard"], default=None)
    p.add_argument("--only", nargs="*", default=None, metavar="CODE")
    p.add_argument("--dry-run", action="store_true",
                   help="List challenges and exit.")
    p.add_argument("--runs-dir", default=None,
                   help="Where to store blackboard DBs (default: solver_runs/).")
    p.add_argument(
        "--skills-dir", default=None,
        help="Host dir of extra .claude/skills to mount into the worker "
             "(default: the bundled wormhole/solver/skills). Pass '' to disable.",
    )
    p.add_argument("--summary-file", default=None)
    p.add_argument("--wall-clock", type=float, default=None,
                   help="Total time budget in minutes. When set, the scheduler "
                        "uses wall-clock requeue (failed challenges cycle until "
                        "the deadline) and gates hint usage to the final 1/6 of "
                        "the window. Required for hosted/competition mode.")
    p.add_argument("-v", "--verbose", action="count", default=0)
    return p


def _print(msg: str) -> None:
    """Print with UTF-8 safety — Windows CMD defaults to GBK and crashes on emoji."""
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        # Strip non-GBK chars (Windows CMD) and retry.
        safe = msg.encode("ascii", errors="replace").decode("ascii")
        print(safe, flush=True)


def main(argv: list[str] | None = None) -> int:
    # Force UTF-8 stdout/stderr — Windows CMD defaults to GBK and crashes on
    # emoji/special chars in log messages (✅❌↻⏸ etc.). This is THE fix for
    # the "0 output after 40 minutes" bug: every challenge was crashing on
    # the first emoji print, so nothing ever completed.
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    args = _build_parser().parse_args(argv)

    level = logging.DEBUG if args.verbose >= 2 else (logging.INFO if args.verbose == 1 else logging.WARNING)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s | %(message)s", datefmt="%H:%M:%S")
    if args.verbose >= 1:
        logging.getLogger("wormhole.solver").setLevel(logging.DEBUG)

    if not args.base_url or not args.token:
        print("ERROR: --base-url and --token are required (or BENCHMARK_BASE_URL / BENCHMARK_TOKEN).", file=sys.stderr)
        return 2

    try:
        worker_env = load_worker_env()
    except WorkerConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    _print(f"LLM: {worker_env.anthropic_model} @ {worker_env.anthropic_base_url}")

    client = BenchmarkClient(args.base_url, args.token)

    if args.dry_run:
        try:
            challenges = client.list_challenges()
        except ChallengeError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        _print(f"{len(challenges)} challenge(s):")
        for c in challenges:
            done = "✓" if c.get("is_completed") else f"{c.get('correct_flag_count',0)}/{c.get('flag_count',1)}"
            _print(f"  {c['unique_code']:30} [{c.get('difficulty','?'):6}] lvl{c.get('level','?')} flags:{done}")
        return 0

    runs_dir = Path(args.runs_dir or "solver_runs")
    runs_dir.mkdir(parents=True, exist_ok=True)

    # Resolve the skills directory: default to the bundled skills. Pass
    # --skills-dir "" to disable mounting.
    if args.skills_dir == "":
        skills_dir = None
    elif args.skills_dir:
        skills_dir = args.skills_dir
    else:
        bundled = Path(__file__).parent / "skills"
        skills_dir = str(bundled) if bundled.is_dir() else None
    if skills_dir:
        _print(f"skills: {skills_dir} (mounted into worker .claude/skills)")

    cfg = DispatcherConfig(
        task_timeout=args.task_timeout,
        bootstrap_timeout=args.bootstrap_timeout,
        max_rounds=args.max_rounds,
        max_intents=args.max_intents,
        max_parallel_explores=args.max_parallel_explores,
        health_check=not args.no_health_check,
        infra_down_threshold=args.infra_down_threshold,
        flag_stagnation_base=args.flag_stagnation_base,
        flag_stagnation_per_flag=args.flag_stagnation_per_flag,
    )
    cfg._per_challenge_budget = args.per_challenge_budget  # type: ignore[attr-defined]
    # Honor --no-reset by making the dispatcher treat the one-shot reset as
    # already consumed (so stagnation fires immediately on the first stall).
    cfg._disable_reset = args.no_reset  # type: ignore[attr-defined]

    async def _run():
        try:
            challenges = await asyncio.to_thread(client.list_challenges)
        except ChallengeError as exc:
            _print(f"ABORT: {exc}")
            return []

        pending = [c for c in challenges if not c.get("is_completed")]
        if args.difficulty:
            pending = [c for c in pending if c.get("difficulty") == args.difficulty]
        if args.only:
            only = set(args.only)
            pending = [c for c in pending if c.get("unique_code") in only]
        pending = sort_challenges(pending)
        _print(f"{len(pending)} challenge(s) to solve (concurrency={args.concurrency})")

        # Build a per-challenge solve closure that receives the time budget
        # from the Scheduler and injects it as _per_challenge_budget.
        async def _solve_one(ch, budget=None, attempt=1, allow_hint=False):
            from copy import deepcopy
            ch_cfg = deepcopy(cfg)
            if budget and budget > 0:
                ch_cfg._per_challenge_budget = budget
            return await solve_challenge(
                client, ch, image=args.image, worker_env=worker_env,
                runs_dir=runs_dir, cfg=ch_cfg, log=_print,
                skills_dir=skills_dir, attempt=attempt, allow_hint=allow_hint,
            )

        scheduler = Scheduler(
            _solve_one, pending,
            concurrency=args.concurrency, log=_print,
            wall_clock_deadline=(
                time.monotonic() + args.wall_clock * 60
                if args.wall_clock else None
            ),
        )
        return await scheduler.run()

    outcomes = asyncio.run(_run())

    _print("=" * 60)
    _print("SOLVE COMPLETE")
    total_accepted = sum(len(o["accepted"]) for o in outcomes)
    _print(f"  flags accepted: {total_accepted}")
    for o in outcomes:
        mark = "✓" if o["solved"] else ("·" if o["accepted"] else "✗")
        _print(f"  {mark} {o['unique_code']:30} {o['correct_flag_count']}/{o['total_flag_count']}"
               + (f" — {o['error']}" if o["error"] else ""))
    _print("=" * 60)

    if args.summary_file:
        with open(args.summary_file, "w", encoding="utf-8") as fh:
            json.dump({"outcomes": outcomes}, fh, indent=2, ensure_ascii=False)
        _print(f"summary → {args.summary_file}")

    return 0 if total_accepted > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
