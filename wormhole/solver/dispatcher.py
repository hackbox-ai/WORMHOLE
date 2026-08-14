"""Dispatcher: the OODA scheduling loop that drives one challenge to completion.

Each tick the dispatcher:
  1. reclaims stale intent leases (a crashed/timed-out explore's claim expires)
  2. optionally probes worker health; if the LLM endpoint is down, backs off
     instead of wasting a long task timeout on a dead endpoint
  3. decides which task(s) to run next:
       - initial board (only origin+goal)      → bootstrap
       - graph changed since last reason       → reason
       - unclaimed open intents exist           → explore (UP TO N in parallel)
       - otherwise                              → wait one tick
  4. runs the task(s) — explores fire concurrently via asyncio.gather
  5. stops when the board is "complete" (and flag count is met) or deadline

Parallel explores: when reason proposes multiple intents, the dispatcher can
explore them concurrently (up to ``max_parallel_explores``). Each explore is a
separate ``claude -p`` invocation inside the same container, so they share the
filesystem but not conversation state. This roughly halves wall-clock time on
multi-intent challenges vs the old serial model.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Callable

from wormhole.solver.blackboard import Blackboard
from wormhole.solver.constants import FLAG_RE
from wormhole.solver.tasks import (
    STATUS_COMPLETE,
    STATUS_FAILED,
    run_bootstrap,
    run_explore,
    run_reason,
    run_reason_reset,
)
from wormhole.solver.worker import ClaudeCodeWorker

logger = logging.getLogger(__name__)

# Defaults (overridable via DispatcherConfig).
DEFAULT_TICK = 2.0                 # seconds between scheduling decisions
DEFAULT_TASK_TIMEOUT = 600.0       # explore/reason wall-clock per call (10 min).
                                   # Bootstrap gets its own (longer) timeout below.
                                   # Was 1200s — caused 2-round stuck challenges to
                                   # burn 40+ min (c-02/c-03) before any gate fired,
                                   # because each parallel explore hit the full 20min.
                                   # 10min keeps single-round cost manageable while
                                   # still giving claude enough time to do real work.
DEFAULT_BOOTSTRAP_TIMEOUT = 1200.0 # bootstrap = full first attempt (20 min) — keep generous,
                                   # most challenges are solved here in one shot.
DEFAULT_CONCLUDE_TIMEOUT = 300.0   # conclude-fallback wall-clock (5 min)
DEFAULT_HEARTBEAT_TIMEOUT = 1800.0 # reclaim a claimed intent after 30 min silent
DEFAULT_MAX_INTENTS = 3            # cap intents one reason round can create
DEFAULT_MAX_ROUNDS = 15            # enough rounds for deep exploration
DEFAULT_EXPLORE_RETRIES = 2        # retry failed intents
DEFAULT_STAGNATION_ROUNDS = 6      # legacy: max rounds with no new FACTS. Flag-aware gate below is stricter.
DEFAULT_FLAG_STAGNATION_BASE = 3   # rounds with no new FLAG before stopping (0-flag case)
DEFAULT_FLAG_STAGNATION_PER_FLAG = 2  # extra tolerance per flag already found
DEFAULT_MAX_PARALLEL_EXPLORES = 3  # concurrent explores within one challenge
UNHEALTHY_BACKOFF = 15.0           # seconds to skip a failed worker before retry
# Infrastructure-down detection: when this many RECENT explore facts all report
# the target is unreachable, the challenge container has almost certainly died
# (we saw this on a-13/a-16/b-02: target was permanently down but the loop kept
# burning budget for 2+ hours proposing yet-unreachable directions). Stop early
# and free the slot for an unsolved challenge instead.
DEFAULT_INFRA_DOWN_THRESHOLD = 4
# Phrases in a fact description that indicate the target isn't responding.
# Matched case-insensitively against the lowercase description.
INFRA_DOWN_PHRASES = (
    "unreachable",
    "unresponsive",
    "connection refused",
    "econnrefused",
    "timed out",            # "connection timed out", "curl timed out"
    "timeout",              # bare "timeout" (curl --max-time)
    "eagain",
    "no route to host",
    "network is unreachable",
    "host is down",
    "no-carrier",           # docker bridge down
    "container dead",
    "永久不可达",            # 中文日志里常见
    "无法访问",
    "网络中断",
)


@dataclass
class DispatcherConfig:
    tick: float = DEFAULT_TICK
    task_timeout: float = DEFAULT_TASK_TIMEOUT
    bootstrap_timeout: float = DEFAULT_BOOTSTRAP_TIMEOUT
    conclude_timeout: float = DEFAULT_CONCLUDE_TIMEOUT
    heartbeat_timeout: float = DEFAULT_HEARTBEAT_TIMEOUT
    max_intents: int = DEFAULT_MAX_INTENTS
    max_rounds: int = DEFAULT_MAX_ROUNDS
    explore_retries: int = DEFAULT_EXPLORE_RETRIES
    stagnation_rounds: int = DEFAULT_STAGNATION_ROUNDS
    max_parallel_explores: int = DEFAULT_MAX_PARALLEL_EXPLORES
    health_check: bool = False      # disabled — wastes time on a working endpoint
    infra_down_threshold: int = DEFAULT_INFRA_DOWN_THRESHOLD
    # Flag-aware stagnation: the loop stops when no NEW FLAG has appeared for
    # ``flag_stagnation_base + flag_stagnation_per_flag * flags_found`` rounds.
    # This is the single most important anti-waste gate — the old fact-count
    # stagnation never fired because every explore produces a "negative result"
    # fact (e.g. "SQLi ruled out"), keeping the fact total growing while the
    # flag count stays at 0. Result: 6 challenges burned 2.6h + ~1M tokens each
    # circling dead ends. See root-cause analysis on the 9100-point run.
    flag_stagnation_base: int = DEFAULT_FLAG_STAGNATION_BASE
    flag_stagnation_per_flag: int = DEFAULT_FLAG_STAGNATION_PER_FLAG


@dataclass
class SolveResult:
    """Outcome of running the OODA loop on one challenge."""

    completed: bool = False
    rounds: int = 0
    facts_added: int = 0
    intents_created: int = 0
    reasons_run: int = 0
    explores_run: int = 0
    bootstraps_run: int = 0
    health_skips: int = 0           # ticks skipped due to unhealthy worker
    errors: list[str] = field(default_factory=list)
    stop_reason: str = ""


class Dispatcher:
    """Schedules bootstrap/reason/explore tasks against a blackboard.

    Construction takes the already-created ``Blackboard`` and ``ClaudeCodeWorker``
    (the dispatcher owns neither — the caller manages their lifecycles so the
    CLI can clean up containers / dbs uniformly).
    """

    def __init__(
        self,
        blackboard: Blackboard,
        worker: ClaudeCodeWorker,
        config: DispatcherConfig | None = None,
        log=None,
        *,
        target_flag_count: int = 0,
        on_flag_found: Callable[[str], None] | None = None,
        invalid_flags: set[str] | None = None,
    ) -> None:
        self.bb = blackboard
        self.worker = worker
        self.cfg = config or DispatcherConfig()
        self._log = log or (lambda msg: logger.info(msg))
        # Track graph state to decide when reason should re-run.
        self._reason_checkpoint = self.bb.checkpoint()
        self._bootstrap_done = False
        # Multi-flag hard gate: the challenge isn't "complete" until we've found
        # at least ``target_flag_count`` distinct flags. 0 = trust the board's
        # is_completed (Cairn-compatible, single-flag behaviour).
        self._target_flag_count = target_flag_count
        # Real-time flag submission callback. When set, the dispatcher calls it
        # with each NEW flag string the moment it appears in a fact — so multi-
        # flag challenges (B-series: 4 flags each) submit incrementally instead
        # of waiting for the entire solve to finish. This protects against
        # budget-exhaustion / infra-down exits losing already-found flags.
        self._on_flag_found = on_flag_found
        self._submitted_flags: set[str] = set()
        # Flags the platform REJECTED on a prior attempt — almost always because
        # the target container rotated and the flag value changed (env rotation,
        # see cloud-multi.md §0). Excluded from the "found enough flags?" gate so
        # a retry that inherits a graph full of STALE flags does not immediately
        # declare goal-reached (the rounds=0 false-complete bug) without ever
        # re-verifying the live target.
        self._invalid_flags: set[str] = set(invalid_flags or ())
        # Track how many times each intent has been explored (for retry budget).
        self._explore_attempts: dict[str, int] = {}
        # Stagnation detection: rounds since the last NEW fact was added.
        self._facts_at_last_check = len(self.bb.facts)
        self._stagnant_rounds = 0
        # Flag-aware stagnation: rounds since the last NEW FLAG appeared.
        # This is stricter and more meaningful than fact-count stagnation —
        # it catches the "circling dead ends, each producing a negative-result
        # fact" failure mode that burned ~1M tokens per stuck challenge.
        self._flags_at_start = self._flags_found()
        self._flag_stagnant_rounds = 0
        # Health gate: when the worker fails a health probe, skip dispatching
        # until this timestamp (avoids burning long task timeouts on a dead
        # LLM endpoint — same pattern as Cairn's worker_unhealthy_until).
        self._unhealthy_until: float = 0.0
        self._health_checked_this_session = False
        # Infrastructure-down detection: count the most recent explore facts
        # that report the target as unreachable. We scan the tail of the fact
        # list every tick — if the threshold is met AND no flag has been found,
        # the loop stops with stop_reason="infra_down" so the slot frees up.
        self._infra_down_announced = False
        # Hypothesis-reset gate: when stagnation is about to fire, give the
        # model ONE forced reset turn first (reason_reset template) that lists
        # every dead-end fact and demands a fresh attack surface. Only if that
        # also fails to produce new facts do we actually give up.
        # ``_disable_reset`` lets users A/B-test by short-circuiting straight
        # to stagnation exit (set via DispatcherConfig._disable_reset).
        self._reset_attempted = bool(getattr(config, "_disable_reset", False))
        self._force_reset = False
        # Per-challenge wall-clock deadline (set by solve()). When set, every
        # explore/reason task gets its timeout CLAMPED to the remaining budget
        # so a 20-minute explore can't blow past a 30-minute total budget.
        self._deadline: float | None = None

    async def solve(self, deadline: float | None = None) -> SolveResult:
        """Run the OODA loop until complete, max_rounds, or deadline.

        Args:
            deadline: absolute ``time.monotonic()`` deadline; None = no limit
                      (still bounded by max_rounds).
        """
        result = SolveResult()
        # Remember the deadline so _run_action can clamp per-task timeouts to
        # the REMAINING budget. Without this, a 20-minute explore that starts
        # at minute 29 of a 30-minute budget runs to minute 49 — the deadline
        # check at the top of the loop only fires BETWEEN tasks, never during.
        # See "budget 穿透" root-cause analysis: 6 stuck challenges averaged
        # 2.6h each against a 30min budget because the long task_timeout
        # (1200s) blew past the deadline every single round.
        self._deadline = deadline
        start_facts = len(self.bb.facts)
        start_intents = len(self.bb.all_intents)

        try:
            while result.rounds < self.cfg.max_rounds:
                # ---- Completion gate (multi-flag aware) ----
                # Two conditions must BOTH hold:
                #   (a) the board's "complete" flag is set (reason judged goal met), AND
                #   (b) if we have a target_flag_count, we've actually found that many.
                # This prevents the #1 failure mode: claude declares "complete"
                # after finding 1 of 3 flags, and the loop exits early.
                if self.bb.is_completed and self._flags_found() >= self._target_flag_count:
                    result.completed = True
                    result.stop_reason = "goal reached"
                    break
                if deadline is not None and time.monotonic() > deadline:
                    result.stop_reason = "deadline exceeded"
                    break

                result.rounds += 1
                self.bb.expire_stale(self.cfg.heartbeat_timeout)

                # ---- Stagnation detection ----
                # Two layers:
                #   (1) FLAG-aware stagnation (primary anti-waste gate):
                #       counts rounds since the last NEW FLAG. Since flags are
                #       the objective, "no new flag for N rounds" is the truest
                #       signal that the loop is wasting tokens. Tolerance grows
                #       with flags already found (multi-flag challenges deserve
                #       more patience). This is what catches a-03/a-14/b-02
                #       style "7 rounds, 0 flags, 1M tokens burned" runs.
                #   (2) FACT-count stagnation (legacy backup):
                #       catches the rarer "reason↔explore ping-pong producing
                #       literally nothing" case (no new facts at all).
                #
                # GRACE PERIOD: the first ``flag_stagnation_base`` rounds get a
                # free pass on flag-stagnation — bootstrap + initial recon is
                # supposed to produce zero flags while it maps the attack
                # surface. Without this, a challenge that needs 3 rounds of
                # recon before its first flag (complex chains, AD pivoting)
                # would be killed before it even got started. Only AFTER the
                # grace period does the "no new flag" counter start ticking.
                current_facts = len(self.bb.facts)
                current_flags = self._flags_found()
                if current_facts > self._facts_at_last_check:
                    self._facts_at_last_check = current_facts
                    self._stagnant_rounds = 0
                else:
                    self._stagnant_rounds += 1
                # Flag stagnation counter (only starts after grace period)
                if current_flags > self._flags_at_start:
                    # NEW flags appeared this round — fire the real-time
                    # submission callback for each one we haven't submitted
                    # yet. This ensures multi-flag challenges (B-series: 4
                    # flags) bank each flag the moment it's discovered, rather
                    # than waiting for the entire solve to finish (which might
                    # exit early due to budget/infra-down/stagnation).
                    self._submit_new_flags()
                    self._flags_at_start = current_flags
                    self._flag_stagnant_rounds = 0
                    # A new flag means real progress — allow one more reset if
                    # we stall again later. This lets multi-flag challenges
                    # (b-01 style) get a fresh reset per flag-found milestone.
                    self._reset_attempted = False
                elif result.rounds > self.cfg.flag_stagnation_base:
                    # Past grace period and no new flag → start counting.
                    self._flag_stagnant_rounds += 1

                # Tolerance: fixed base + extra per flag already found.
                # NOTE: we deliberately do NOT increase tolerance after a reset
                # — the reset is a second chance with a fresh direction, not a
                # license to burn twice as many tokens. The same tolerance
                # applies so a genuine dead end exits promptly even post-reset.
                flag_tolerance = self.cfg.flag_stagnation_base + self.cfg.flag_stagnation_per_flag * current_flags
                if self._flag_stagnant_rounds >= flag_tolerance:
                    # Last chance: force a hypothesis-reset reason turn before
                    # giving up. This injects the full list of dead-end facts
                    # and demands a *new* attack surface — occasionally unblocks
                    # a-03 / a-14 style "stuck circling the same vulnerability".
                    if not self._reset_attempted:
                        self._reset_attempted = True
                        self._log(
                            f"⚠ flag stagnation: {self._flag_stagnant_rounds} rounds "
                            f"without new flag ({current_flags} found) — "
                            f"forcing hypothesis-reset reason"
                        )
                        self._flag_stagnant_rounds = 0
                        self._stagnant_rounds = 0
                        self._force_reset = True
                    else:
                        result.stop_reason = (
                            f"flag_stagnation: no new flag for "
                            f"{self._flag_stagnant_rounds} rounds "
                            f"(found {current_flags}, tolerance {flag_tolerance})"
                        )
                        self._log(f"⚠ {result.stop_reason} — stopping to save budget")
                        break
                elif self._stagnant_rounds >= self.cfg.stagnation_rounds:
                    # Backup: no new facts AT ALL for many rounds (much rarer
                    # than flag stagnation, but catches deadlocks where reason
                    # and explore produce zero output).
                    result.stop_reason = (
                        f"stagnation: no new facts for {self.cfg.stagnation_rounds} rounds"
                    )
                    self._log(f"⚠ {result.stop_reason} — stopping to save budget")
                    break

                # ---- Infrastructure-down detection ----
                # If the target container has died (we see this in 5-10% of
                # runs), every recent explore fact will report unreachable /
                # timeout / refused. Continuing burns 2+ hours of budget for
                # nothing. Stop early and free the concurrency slot.
                if self._is_infra_down():
                    result.stop_reason = (
                        f"infra_down: last {self.cfg.infra_down_threshold} explores "
                        f"all report target unreachable"
                    )
                    self._log(f"⚠ {result.stop_reason} — target appears dead, stopping")
                    break

                # ---- Health gate ----
                # If the worker's LLM endpoint is down (rate limit, network
                # blip), skip dispatching until the backoff window expires.
                # This prevents a cascade of 10-minute task timeouts on a dead
                # endpoint — same pattern as Cairn's worker_unhealthy_until.
                if self.cfg.health_check and self._is_worker_unhealthy():
                    result.health_skips += 1
                    self._log(
                        f"⏸ worker unhealthy (LLM endpoint down?), "
                        f"backing off {UNHEALTHY_BACKOFF:.0f}s "
                        f"(skip #{result.health_skips})"
                    )
                    await asyncio.sleep(UNHEALTHY_BACKOFF)
                    continue

                action = self._pick_action()
                if action is None:
                    # Nothing to do right now — wait a tick and re-evaluate.
                    await asyncio.sleep(self.cfg.tick)
                    continue

                await self._run_action(action, result)

        except Exception as exc:  # noqa: BLE001 — never let the loop die silently
            result.errors.append(f"dispatcher crashed: {exc}")
            result.stop_reason = f"error: {exc}"
            logger.exception("dispatcher loop crashed")

        result.facts_added = len(self.bb.facts) - start_facts
        result.intents_created = len(self.bb.all_intents) - start_intents
        if not result.stop_reason:
            result.stop_reason = "max_rounds reached"
        self._log(
            f"solve done: completed={result.completed} rounds={result.rounds} "
            f"facts+={result.facts_added} intents+={result.intents_created} "
            f"(stop={result.stop_reason})"
        )
        return result

    # ------------------------------------------------------------------ #
    # Health gate
    # ------------------------------------------------------------------ #

    def _is_worker_unhealthy(self) -> bool:
        """True if the worker is in an unhealthy backoff window.

        On the first call of a session, does a proactive probe (cheap claude -p
        with a trivial prompt). After that, only checks the backoff timestamp
        set by ``_mark_unhealthy`` when a task fails with an endpoint error.
        """
        now = time.monotonic()
        if now < self._unhealthy_until:
            return True
        # One-shot startup probe: confirm the LLM endpoint is alive before the
        # first long task. Subsequent ticks rely on task-failure-driven marking.
        if not self._health_checked_this_session:
            self._health_checked_this_session = True
            healthy = self.worker.check_health(timeout=30)
            if not healthy:
                self._mark_unhealthy("startup health probe failed")
                return True
        return False

    def _mark_unhealthy(self, reason: str) -> None:
        """Put the worker in a backoff window after a failure."""
        self._unhealthy_until = time.monotonic() + UNHEALTHY_BACKOFF
        logger.warning("worker marked unhealthy for %.0fs: %s", UNHEALTHY_BACKOFF, reason)

    # ------------------------------------------------------------------ #
    # Budget enforcement
    # ------------------------------------------------------------------ #

    def _task_timeout(self, nominal: float) -> float:
        """Clamp a per-task timeout to the remaining wall-clock budget.

        ``nominal`` is the configured timeout (e.g. task_timeout=1200s). If a
        per-challenge deadline is set, we return ``min(nominal, remaining)``
        so that the worker's Popen hard-kill fires when the budget runs out,
        not 20 minutes later. Always leaves a small floor (5s) so the task at
        least gets to start — a 0s timeout would fail instantly without
        giving the conclude-fallback a chance to salvage a fact.
        """
        if self._deadline is None:
            return nominal
        remaining = self._deadline - time.monotonic()
        if remaining <= 5:
            # Budget essentially exhausted — return a tiny floor so the caller
            # can still attempt a conclude-fallback rather than hard-crashing.
            return 5.0
        return min(nominal, remaining)

    # ------------------------------------------------------------------ #
    # Infrastructure-down detection
    # ------------------------------------------------------------------ #

    def _is_infra_down(self) -> bool:
        """True if the last N explore facts all report the target unreachable.

        Scans only the tail of the fact list (skipping origin/goal) — once the
        target has been down for several consecutive explores, there's no
        reason to keep dispatching. Crucially this does NOT fire if we've
        already found a flag: a dead target on a multi-flag challenge may just
        mean we need to read more from the already-captured data, not that the
        whole run is wasted.
        """
        threshold = self.cfg.infra_down_threshold
        if threshold <= 0:
            return False
        # If we've already captured a flag, the run has produced value — keep
        # going so we can extract / submit it even if the target later died.
        if self._flags_found() > 0:
            return False
        recent = [f for f in self.bb.facts if f.id not in ("origin", "goal")][-threshold:]
        if len(recent) < threshold:
            return False
        return all(self._fact_reports_unreachable(f.description) for f in recent)

    @staticmethod
    def _fact_reports_unreachable(description: str) -> bool:
        """Heuristic: does this fact's text indicate the target isn't responding?"""
        if not description:
            return False
        lower = description.lower()
        # Must contain one of the phrases. The "exhausted / no flag" negatives
        # (e.g. "Exhausted 3 attempts... no flag found") are NOT infra-down
        # signals — they're genuine dead ends, handled by stagnation instead.
        return any(phrase in lower for phrase in INFRA_DOWN_PHRASES)

    # ------------------------------------------------------------------ #
    # Scheduling decision
    # ------------------------------------------------------------------ #

    def _pick_action(self) -> str | None:
        """Decide which task to run this tick.

        Returns one of 'bootstrap' / 'reason' / 'explore', or None if nothing
        is actionable right now.
        """
        # 1. Initial board: bootstrap once.
        if not self._bootstrap_done and self.bb.is_initial:
            self._bootstrap_done = True
            return "bootstrap"

        # 1a. HYPOTHESIS-RESET: when stagnation triggered a forced reset, run
        # the reset reason variant BEFORE anything else. This bypasses the
        # normal "graph changed → reason" decision because the whole point is
        # to inject a creative-new-direction prompt that the ordinary reason
        # template wouldn't produce. Consumed once, then back to normal flow.
        if self._force_reset:
            self._force_reset = False
            return "reason_reset"

        # 1b. PREMATURE COMPLETION GUARD: the board says "complete" but we
        # haven't found enough flags. Clear the false completion and force a
        # reason so the worker re-plans toward the missing flags. Without this,
        # the loop deadlocks: is_completed=True blocks exit 4, but the flag
        # gate in solve() blocks the real exit → infinite None ticks → stagnation.
        if self.bb.is_completed and self._target_flag_count > 0:
            found = self._flags_found()
            if found < self._target_flag_count:
                self._log(
                    f"⚠ premature complete: {found}/{self._target_flag_count} flags — "
                    f"clearing completion, forcing re-reason"
                )
                self.bb.clear_completion()
                return "reason"

        unclaimed = self.bb.unclaimed_intents
        graph_changed = self.bb.has_changed_since(self._reason_checkpoint)

        # 2. Graph evolved (new facts/hints/intents) → re-reason to steer.
        if graph_changed:
            return "reason"

        # 3. Nothing new to reason about, but work is queued → explore.
        if unclaimed:
            return "explore"

        # 4. Stuck: no changes and no open work. Force a reason to break out
        #    (it may propose a new direction, or declare complete).
        if not self.bb.open_intents and not self.bb.is_completed:
            return "reason"

        return None

    async def _run_action(self, action: str, result: SolveResult) -> None:
        if action == "bootstrap":
            result.bootstraps_run += 1
            self._log(f"[round {result.rounds}] bootstrap")
            status = await run_bootstrap(
                self.bb, self.worker,
                self._task_timeout(self.cfg.bootstrap_timeout),
                self._task_timeout(self.cfg.conclude_timeout),
            )
            if status == STATUS_COMPLETE:
                result.completed = True
            elif status == STATUS_FAILED:
                result.errors.append("bootstrap failed")
            # After bootstrap, force a reason on the next tick to plan next steps.
            self._reason_checkpoint = self.bb.checkpoint()

        elif action == "reason":
            result.reasons_run += 1
            self._log(f"[round {result.rounds}] reason (facts={len(self.bb.facts)})")
            status = await run_reason(
                self.bb, self.worker,
                self._task_timeout(self.cfg.task_timeout), self.cfg.max_intents
            )
            if status == STATUS_COMPLETE:
                result.completed = True
            elif status == STATUS_FAILED:
                result.errors.append("reason failed")
            # Refresh the checkpoint regardless — we just reasoned about this state.
            self._reason_checkpoint = self.bb.checkpoint()

        elif action == "reason_reset":
            # Forced hypothesis reset. Counts as a reason run for stats. The
            # reset template is intentionally more aggressive about demanding
            # NEW directions, so even if ordinary reason would noop here, the
            # reset may still produce fresh intents.
            result.reasons_run += 1
            self._log(
                f"[round {result.rounds}] reason_reset "
                f"(forcing fresh attack surface, facts={len(self.bb.facts)})"
            )
            status = await run_reason_reset(
                self.bb, self.worker,
                self._task_timeout(self.cfg.task_timeout), self.cfg.max_intents
            )
            if status == STATUS_COMPLETE:
                # Reset gave up — mark completed=False so the loop falls through
                # to stagnation exit on the next tick (one reset per session).
                result.completed = False
            elif status == STATUS_FAILED:
                result.errors.append("reason_reset failed")
            self._reason_checkpoint = self.bb.checkpoint()

        elif action == "explore":
            # Claim up to max_parallel_explores unclaimed intents, then run them
            # concurrently. Claiming all up-front (sequentially) avoids SQLite
            # write contention during the parallel explore phase.
            available = self.bb.unclaimed_intents
            batch_size = min(self.cfg.max_parallel_explores, len(available))
            batch = available[:batch_size]

            # Pre-claim each intent in the batch so parallel explores don't
            # race on the same one. claim_intent sets worker=, removing it from
            # unclaimed_intents for the next tick.
            for idx, intent in enumerate(batch):
                self._explore_attempts[intent.id] = (
                    self._explore_attempts.get(intent.id, 0) + 1
                )
                try:
                    self.bb.claim_intent(intent.id, f"explore-{idx}")
                except ValueError:
                    # Someone else claimed it between our read and claim — skip.
                    batch = [i for i in batch if i.id != intent.id]

            if not batch:
                return

            result.explores_run += len(batch)
            ids_str = ", ".join(i.id for i in batch)
            # Clamp explore + conclude timeouts to remaining budget so a
            # 20-minute explore can't blow past the per-challenge deadline.
            explore_to = self._task_timeout(self.cfg.task_timeout)
            conclude_to = self._task_timeout(self.cfg.conclude_timeout)
            self._log(
                f"[round {result.rounds}] explore {ids_str} "
                f"({len(batch)} parallel, timeout={explore_to:.0f}s)"
            )

            # Fire all explores concurrently. Each runs in its own thread via
            # asyncio.to_thread inside run_explore, so they truly overlap.
            statuses = await asyncio.gather(*[
                run_explore(
                    self.bb, self.worker, intent,
                    explore_to, conclude_to,
                    worker_name=f"explore-{idx}",
                )
                for idx, intent in enumerate(batch)
            ])

            # Process results: retry or abandon as needed.
            for intent, status in zip(batch, statuses):
                attempt = self._explore_attempts[intent.id]
                if status == STATUS_FAILED:
                    result.errors.append(f"explore {intent.id} failed")
                    if attempt <= self.cfg.explore_retries:
                        self._log(
                            f"  ↻ will retry {intent.id} "
                            f"({attempt}/{self.cfg.explore_retries} retries left)"
                        )
                    else:
                        self.bb.conclude(
                            intent.id,
                            f"Exhausted {attempt} attempts on: {intent.description}. "
                            f"No flag found via this path.",
                        )
                        self._log(f"  ✗ {intent.id} abandoned after {attempt} attempts")
            # Exploring added facts → graph changed → reason will fire next.

    def _flags_found(self) -> int:
        """Count distinct flag{...} strings recorded in fact descriptions.

        Excludes ``_invalid_flags`` (platform-rejected on a prior attempt, e.g.
        after env rotation) — otherwise a retry that inherits a graph full of
        stale flags reports "found N" and falsely goal-reaches at rounds=0.
        """
        seen = set()
        for fact in self.bb.facts:
            for m in FLAG_RE.finditer(fact.description):
                seen.add(m.group(0))
        return len(seen - self._invalid_flags)

    def _submit_new_flags(self) -> None:
        """Fire the real-time submission callback for any un-submitted flags."""
        if not self._on_flag_found:
            return
        for fact in self.bb.facts:
            for m in FLAG_RE.finditer(fact.description):
                flag = m.group(0)
                if flag in self._invalid_flags:
                    continue
                if flag not in self._submitted_flags:
                    self._submitted_flags.add(flag)
                    try:
                        self._on_flag_found(flag)
                    except Exception:  # noqa: BLE001 — never let submit crash the loop
                        logger.warning("on_flag_found callback failed for %s", flag[:40], exc_info=True)
