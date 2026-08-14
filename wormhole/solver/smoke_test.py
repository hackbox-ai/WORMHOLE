#!/usr/bin/env python
"""End-to-end smoke test for the Wormhole solver.

Verifies the full stack — container + claude CLI + DeepSeek LLM + skills mount
+ blackboard + dispatcher — with a real (but trivial) challenge: a flag file
planted in the container that claude must find via bash.

Run from the project src/ dir:
    python -m wormhole.solver.smoke_test

Exits 0 on success, 1 on any failure. Each stage prints a clear PASS/FAIL so
you can see exactly where it breaks if it does.
"""
from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# The flag we plant for claude to find. Distinctive so it can't be confused
# with anything else in the container.
SMOKE_FLAG = "flag{smoke_test_passed_2026}"
CONTAINER = "wormhole-smoke-test"

# --------------------------------------------------------------------------- #
# Test harness
# --------------------------------------------------------------------------- #

_PASS = "\033[32mPASS\033[0m"
_FAIL = "\033[31mFAIL\033[0m"
_SKIP = "\033[33mSKIP\033[0m"


def stage(name: str) -> None:
    print(f"\n{'='*60}\n  {name}\n{'='*60}")


def check(label: str, ok: bool, detail: str = "") -> bool:
    mark = _PASS if ok else _FAIL
    print(f"  [{mark}] {label}" + (f" — {detail}" if detail and ok else ""))
    if not ok and detail:
        print(f"         {detail}")
    return ok


def run(cmd: list[str], timeout: float = 60) -> tuple[int, str, str]:
    """Run a command, return (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace")
        return r.returncode, r.stdout or "", r.stderr or ""
    except subprocess.TimeoutExpired as e:
        return -1, "", f"timeout after {timeout}s"
    except FileNotFoundError:
        return -2, "", f"command not found: {cmd[0]}"


# --------------------------------------------------------------------------- #
# Stages
# --------------------------------------------------------------------------- #

def test_container_and_auth(image: str, env) -> bool:
    """Stage 1: container starts, claude CLI works, DeepSeek auth succeeds."""
    stage("Stage 1: Container + claude CLI + DeepSeek auth")

    # Clean up any leftover.
    run(["docker", "rm", "-f", CONTAINER])

    skills_dir = str(Path(__file__).parent / "skills")
    from wormhole.solver.worker import ClaudeCodeWorker
    try:
        ClaudeCodeWorker.ensure_container(CONTAINER, image, env, skills_dir=skills_dir)
    except Exception as exc:
        return check("container start", False, str(exc))
    if not check("container started", True, CONTAINER):
        return False

    # claude --version inside container
    rc, out, _ = run(["docker", "exec", CONTAINER, "claude", "--version"])
    if not check("claude CLI present", rc == 0, out.strip()[:60]):
        return False

    # Plant the smoke flag BEFORE claude runs, so it has something to find.
    rc, _, err = run([
        "docker", "exec", CONTAINER, "bash", "-c",
        f"echo -n '{SMOKE_FLAG}' > /tmp/flag.txt && echo planted",
    ])
    if not check("flag file planted", rc == 0, err[:100]):
        return False

    # Minimal claude call to verify auth (not the full solver yet).
    print("  [....] testing claude auth (calling DeepSeek, ~15s)...")
    t0 = time.time()
    rc, out, err = run([
        "docker", "exec", CONTAINER, "claude",
        "--dangerously-skip-permissions", "-p", "--",
        'Reply with exactly: {"status":"ok"}',
    ], timeout=60)
    elapsed = time.time() - t0
    auth_ok = rc == 0 and "Not logged in" not in out and "Not logged in" not in err
    return check("claude auth (DeepSeek)", auth_ok,
                 f"responded in {elapsed:.0f}s" if auth_ok else f"rc={rc} out={out[:120]} err={err[:120]}")


def test_skills_mounted() -> bool:
    """Stage 2: the bundled skill is visible inside the container."""
    stage("Stage 2: Skills mount (ctf-solve-strategy)")

    rc, out, _ = run([
        "docker", "exec", CONTAINER, "ls",
        "/home/kali/workspace/.claude/skills/ctf-solve-strategy/SKILL.md",
    ])
    if not check("SKILL.md mounted", rc == 0):
        return False

    rc, out, _ = run([
        "docker", "exec", CONTAINER, "ls",
        "/home/kali/workspace/.claude/skills/ctf-solve-strategy/references/",
    ])
    refs = out.strip().split("\n") if out.strip() else []
    return check("references mounted", len(refs) >= 5, f"{len(refs)} files")


def test_worker_finds_flag() -> bool:
    """Stage 3: ClaudeCodeWorker.execute() can drive claude to find the flag.

    This is the real deal: claude must use bash to read /tmp/flag.txt and
    report it back as JSON. If this passes, the entire claude↔solver wiring
    works end to end.
    """
    stage("Stage 3: Worker drives claude to find the flag")

    from wormhole.solver.worker import ClaudeCodeWorker
    from wormhole.solver.output_parser import extract_json_object

    worker = ClaudeCodeWorker(CONTAINER)
    prompt = (
        "There is a flag hidden in /tmp/flag.txt on this machine. "
        "Read it with cat, then return ONLY this JSON (nothing else):\n"
        '{"flag":"<the exact flag string you found>"}'
    )
    print(f"  [....] running claude -p (may take 20-60s)...")
    t0 = time.time()
    result = worker.execute(prompt, timeout=120)
    elapsed = time.time() - t0
    print(f"  claude returned in {elapsed:.0f}s (rc={result.returncode}, {len(result.stdout)} chars)")

    if not check("worker.execute completed", result.ok or result.timed_out,
                 result.error or "ok"):
        # Show a snippet of output for debugging.
        print(f"         stdout: {result.stdout[:200]}")
        print(f"         stderr: {result.stderr[:200]}")
        return False

    # Parse the flag out of the JSON.
    try:
        payload = extract_json_object(result.stdout)
    except ValueError:
        return check("claude returned JSON", False,
                     f"no JSON in output: {result.stdout[:200]}")

    found_flag = payload.get("flag", "")
    ok = SMOKE_FLAG in found_flag or SMOKE_FLAG in result.stdout
    return check(f"claude found the flag", ok,
                 found_flag[:60] if found_flag else f"stdout has flag: {SMOKE_FLAG in result.stdout}")


def test_dispatcher_e2e(image: str, env) -> bool:
    """Stage 4: Full dispatcher loop (bootstrap → complete) on the smoke flag.

    Uses the real Blackboard + Dispatcher + tasks, but with a short timeout
    since the challenge is trivial.
    """
    stage("Stage 4: Full dispatcher loop (bootstrap → complete)")

    from wormhole.solver.blackboard import Blackboard
    from wormhole.solver.dispatcher import Dispatcher, DispatcherConfig
    from wormhole.solver.worker import ClaudeCodeWorker

    td = Path("smoke_test_bb.db")
    bb = Blackboard(td)
    bb.create_project(
        origin=(
            f"CTF smoke test. A flag is hidden at /tmp/flag.txt on this machine. "
            f"Read it with `cat /tmp/flag.txt`. The flag looks like flag{{...}}."
        ),
        goal=f"Read /tmp/flag.txt and report the flag. There is exactly 1 flag.",
    )

    worker = ClaudeCodeWorker(CONTAINER)
    cfg = DispatcherConfig(task_timeout=120, max_rounds=4, conclude_timeout=60)
    dp = Dispatcher(bb, worker, cfg, log=lambda m: print(f"    {m}"))

    async def _run():
        return await dp.solve(deadline=time.monotonic() + 300)

    result = asyncio.run(_run())

    ok_completed = check("dispatcher completed", result.completed, result.stop_reason)
    if not ok_completed:
        print(f"         rounds={result.rounds} errors={result.errors}")
        bb.close()
        return False

    # Verify the flag made it onto the board.
    from wormhole.solver.cli_solve import extract_flags_from_board
    flags = extract_flags_from_board(bb)
    bb.close()
    try:
        td.unlink()
    except OSError:
        pass

    return check("flag on blackboard", SMOKE_FLAG in flags, str(flags))


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> int:
    # Force UTF-8 stdout/stderr — Windows CMD defaults to GBK and crashes on
    # the box-drawing/emoji chars used below (╔═╗║╚╝ ❌ ✅). Same fix as
    # cli_solve.py:main and webui.py:main.
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    print("╔══════════════════════════════════════════════════════════╗")
    print("║  Wormhole Solver — End-to-End Smoke Test                 ║")
    print("╚══════════════════════════════════════════════════════════╝")

    # Preflight: docker available?
    rc, _, _ = run(["docker", "info"])
    if not check("docker daemon reachable", rc == 0):
        print("\n❌ Docker not available — cannot run smoke test.")
        return 1

    # Load LLM env from host config.
    from wormhole.solver.cli_solve import load_worker_env
    from wormhole.solver.constants import WorkerConfigError
    try:
        env = load_worker_env()
    except WorkerConfigError as exc:
        print(f"\n❌ {exc}")
        return 1
    print(f"\n  LLM: {env.anthropic_model} @ {env.anthropic_base_url}")
    print(f"  token: {'*' * 8}...{env.anthropic_auth_token[-4:]}")

    image = os.environ.get("SOLVER_IMAGE", "ghcr.io/oritera/cairn-worker-container:latest")

    results: list[bool] = []
    try:
        results.append(("container+auth", test_container_and_auth(image, env)))
        if results[-1][1]:
            results.append(("skills", test_skills_mounted()))
            results.append(("worker", test_worker_finds_flag()))
            results.append(("dispatcher", test_dispatcher_e2e(image, env)))
        else:
            print("\n⚠ Stage 1 failed — skipping stages 2-4.")
    finally:
        # Always clean up the container.
        print(f"\n  cleaning up {CONTAINER}...")
        run(["docker", "rm", "-f", CONTAINER])

    # Summary
    print(f"\n{'='*60}")
    print("  SUMMARY")
    print(f"{'='*60}")
    all_ok = True
    for name, ok in results:
        mark = _PASS if ok else _FAIL
        print(f"  [{mark}] {name}")
        all_ok = all_ok and ok

    print()
    if all_ok:
        print("  ✅ SMOKE TEST PASSED — solver is ready for the benchmark.")
        return 0
    else:
        print("  ❌ SMOKE TEST FAILED — see details above.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
