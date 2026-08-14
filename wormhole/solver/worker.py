"""Worker: drives the claude code CLI inside a Docker container.

Each challenge gets its own long-lived container (``docker run -d ... sleep
infinity``) and the worker runs ``claude -p`` inside it via ``docker exec``.
This mirrors Cairn's ContainerManager + ClaudeCodeDriver but uses the docker
CLI (subprocess) instead of the docker SDK — simpler on Windows and the CLI is
always available where docker is.

Command shapes (faithful to Cairn's claudecode.py):
  execute : docker exec <c> claude --session-id <uuid> --dangerously-skip-permissions -p -- <prompt>
  conclude: docker exec <c> claude -r <session>         --dangerously-skip-permissions -p -- <prompt>

The ``-r`` resume is the conclude-fallback mechanism: when a bootstrap/explore
task times out or returns unparseable output, we resume the *same* session and
send the ``*_conclude`` prompt, which overrides the prior "keep working"
instruction so the model summarizes and stops.
"""
from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

# How we identify "claude didn't log in" style failures in the raw output.
_AUTH_FAILURE_MARKERS = ("Not logged in", "Please run /login", "Invalid API Key")


@dataclass
class WorkerResult:
    """Outcome of one worker invocation."""

    stdout: str
    stderr: str
    returncode: int
    session: str
    timed_out: bool = False
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out and not self.error


@dataclass
class WorkerEnv:
    """The LLM endpoint config injected into the container.

    Defaults to GLM-5.2 via Zhipu's Anthropic-compatible endpoint. Override
    per-worker to point at a different provider.
    """

    anthropic_base_url: str = "https://open.bigmodel.cn/api/anthropic"
    anthropic_auth_token: str = ""
    anthropic_model: str = "glm-5.2"
    extra: dict[str, str] = field(default_factory=dict)

    def as_docker_env(self) -> list[str]:
        """Render as ``-e KEY=VALUE`` flags for ``docker run``/``exec``."""
        flags = [
            "-e", f"ANTHROPIC_BASE_URL={self.anthropic_base_url}",
            "-e", f"ANTHROPIC_AUTH_TOKEN={self.anthropic_auth_token}",
            "-e", f"ANTHROPIC_MODEL={self.anthropic_model}",
        ]
        for k, v in self.extra.items():
            flags.extend(["-e", f"{k}={v}"])
        return flags


class ClaudeCodeWorker:
    """Runs claude code CLI commands inside a named container.

    The container is expected to already be running (created by
    ``ensure_container``). All work happens via ``docker exec`` so the
    container's filesystem and installed tools persist across invocations.
    """

    def __init__(self, container: str, workdir: str = "/home/kali/workspace") -> None:
        self.container = container
        self.workdir = workdir
        # Fail fast if docker isn't usable.
        if not shutil.which("docker"):
            raise RuntimeError(
                "docker CLI not found on PATH — solver requires Docker to run the "
                "worker container."
            )

    # ------------------------------------------------------------------ #
    # Container lifecycle (module-level helpers)
    # ------------------------------------------------------------------ #

    @staticmethod
    def ensure_container(
        name: str,
        image: str,
        env: WorkerEnv,
        *,
        network: str = "host",
        skills_dir: str | None = None,
    ) -> str:
        """Start a long-lived worker container named ``name`` if not running.

        Returns the container name. Uses ``--network host`` so the container
        can reach the benchmark targets over the host's VPN. The env vars
        (LLM endpoint) are baked in at run time.

        ``skills_dir`` (optional) is a host path to a directory of extra
        ``.claude/skills`` content; it's bind-mounted read-only into the
        container at ``/home/kali/workspace/.claude/skills`` so the worker's
        claude CLI auto-discovers them alongside the image's built-in skills.
        """
        # Reuse if already running.
        check = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", name],
            capture_output=True, text=True,
        )
        if check.returncode == 0 and "true" in check.stdout:
            logger.info("worker: reusing running container %s", name)
            return name

        # Container exists but is stopped/crashed → remove it before re-creating.
        # Without this, `docker run --name <name>` hits "container name already
        # in use" Conflict when a previous run left a stopped container behind
        # (e.g. timed out, OOM-killed, or the process was interrupted).
        if check.returncode == 0:
            logger.info("worker: removing stopped container %s before re-create", name)
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)

        cmd = ["docker", "run", "-d", "--name", name, "--network", network]
        # Bind-mount extra skills read-only.
        if skills_dir:
            host_path = _to_docker_path(skills_dir)
            cmd += [
                "-v", f"{host_path}:/home/kali/workspace/.claude/skills:ro",
            ]
        cmd += [*env.as_docker_env(), "-w", "/home/kali/workspace", image, "sleep", "infinity"]
        logger.info("worker: starting container %s (%s, skills=%s)", name, image, bool(skills_dir))
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"docker run failed for {name}: {result.stderr.strip() or result.stdout.strip()}"
            )
        return name

    @staticmethod
    def detect_external_ip(container: str, timeout: float = 15.0) -> str | None:
        """Probe the container's outbound public IP (via the host VPN).

        Needed for reverse-shell / OOB-exfil challenges: the worker must tell
        the target where to call back. The CLAUDE.md shipped in the image has
        this as ``未填写``, so we fill it dynamically. Returns None if the
        probe fails (the worker still runs; it just won't know its callback IP).
        """
        # Try a couple of providers — ifconfig.me is often blocked in CN.
        for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://4.ipw.cn"):
            try:
                r = subprocess.run(
                    ["docker", "exec", container, "curl", "-s", "--max-time", "8", url],
                    capture_output=True, text=True, timeout=timeout,
                )
                ip = r.stdout.strip()
                # Validate it looks like an IP (v4 or v6), not an error page.
                if r.returncode == 0 and ip and _looks_like_ip(ip):
                    logger.info("worker: detected external IP %s (via %s)", ip, url)
                    return ip
            except (subprocess.TimeoutExpired, Exception):  # noqa: BLE001
                continue
        logger.warning("worker: could not detect external IP (callbacks will be blind)")
        return None

    @staticmethod
    def remove_container(name: str) -> None:
        """Stop and remove a worker container (best-effort)."""
        for args in (["docker", "stop", name], ["docker", "rm", "-f", name]):
            subprocess.run(args, capture_output=True, text=True, timeout=30)

    def setup_team_dirs(self) -> None:
        """Create the Slopper-style collaboration directory structure.

        These dirs let parallel explore peers share findings through files
        (in addition to the in-memory blackboard). Each peer can write notes,
        read other peers' findings, and check PROGRESS.md for the big picture.
        """
        dirs = [
            f"{self.workdir}/team/notes",
            f"{self.workdir}/team/findings",
            f"{self.workdir}/solve",
        ]
        for d in dirs:
            subprocess.run(
                ["docker", "exec", self.container, "mkdir", "-p", d],
                capture_output=True, text=True,
            )

    def write_progress(self, content: str) -> None:
        """Write/update PROGRESS.md in the workspace root.

        Called after each fact is added to the blackboard, so parallel peers
        can read the latest findings before starting their own work.
        """
        self.write_file(f"{self.workdir}/PROGRESS.md", content)

    def check_health(self, timeout: float = 60.0) -> bool:
        """Lightweight LLM-endpoint probe via a tiny claude -p call.

        Used by the dispatcher's health gate: before dispatching a long task,
        confirm the LLM endpoint is actually responding. Cheaper than running a
        full task and waiting for it to fail on a dead endpoint.

        Returns True if claude responds (even with an error message — the point
        is the endpoint is reachable, not that the model is smart). False if the
        call times out or the binary is unreachable.

        Timeout default is 60s (not 30) because claude's first call after
        container start can be slow (cold model load + network).
        """
        try:
            result = self.execute(
                'Reply with exactly: {"health":"ok"}', timeout
            )
            return result.ok or (result.timed_out and bool(result.stdout))
        except Exception:  # noqa: BLE001
            return False

    # ------------------------------------------------------------------ #
    # Core invocations
    # ------------------------------------------------------------------ #

    def execute(self, prompt: str, timeout: float) -> WorkerResult:
        """Run a fresh-session task: ``claude --session-id <uuid> -p -- <prompt>``.

        Synchronous (blocks on subprocess); the caller wraps it in
        ``asyncio.to_thread`` so it doesn't stall the event loop.

        Each claude process writes its PID to a per-session file inside the
        container, so that timeout-kill only kills THAT process — not other
        claude processes running concurrently in the same container (parallel
        explores).
        """
        session = str(uuid.uuid4())
        pid_file = f"/tmp/.solver-pid-{session}"
        # Wrap in sh -c: write PID then exec claude, so we can kill precisely.
        argv = [
            "docker", "exec", "-w", self.workdir, self.container,
            "sh", "-c",
            f"echo $$ > {pid_file} && exec claude --session-id {session} "
            f"--dangerously-skip-permissions -p -- \"{_escape_for_shell(prompt)}\"",
        ]
        return self._run(argv, session, timeout, phase="execute", pid_file=pid_file)

    def conclude(self, prompt: str, session: str, timeout: float) -> WorkerResult:
        """Resume a session to deliver the conclude-phase prompt (``claude -r <session>``)."""
        pid_file = f"/tmp/.solver-pid-{session}-conclude"
        argv = [
            "docker", "exec", "-w", self.workdir, self.container,
            "sh", "-c",
            f"echo $$ > {pid_file} && exec claude -r {session} "
            f"--dangerously-skip-permissions -p -- \"{_escape_for_shell(prompt)}\"",
        ]
        return self._run(argv, session, timeout, phase="conclude", pid_file=pid_file)

    def _run(
        self, argv: list[str], session: str, timeout: float, *, phase: str,
        pid_file: str | None = None,
    ) -> WorkerResult:
        """Execute a docker exec command with a hard timeout + precise kill.

        Uses Popen instead of subprocess.run so that on timeout we can:
          1. Kill the docker exec client (frees our thread)
          2. Kill ONLY the claude process for THIS session (via pid_file),
             not other concurrent explores in the same container.
        """
        logger.debug("worker[%s]: %s (timeout=%.0fs)", phase, self._redact(argv), timeout)
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        cancel_reason = ""
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Step 1: kill the docker exec client so communicate() can return.
            proc.kill()
            try:
                stdout, stderr = proc.communicate(timeout=5)
            except Exception:  # noqa: BLE001 — best-effort drain
                stdout, stderr = "", ""
            # Step 2: kill ONLY this session's claude process inside the container.
            # Read the PID from the per-session file and kill just that PID —
            # NOT pkill -f claude, which would kill ALL concurrent explores.
            killed = self._kill_container_pid(pid_file)
            cancel_reason = (
                f"timed out after {timeout:.0f}s"
                + (f" (killed container PID)" if killed else " (no proc to kill)")
            )
            logger.warning("worker[%s]: %s", phase, cancel_reason)
            return WorkerResult(
                stdout=stdout or "", stderr=stderr or "",
                returncode=-1, session=session,
                timed_out=True, error=cancel_reason,
            )

        stdout = stdout or ""
        stderr = stderr or ""
        result = WorkerResult(
            stdout=stdout, stderr=stderr,
            returncode=proc.returncode, session=session,
        )
        # Surface auth/config failures clearly — they doom every subsequent call.
        if any(marker in stdout or marker in stderr for marker in _AUTH_FAILURE_MARKERS):
            result.error = (
                f"claude auth failure (container={self.container}). Check that "
                f"ANTHROPIC_AUTH_TOKEN/BASE_URL/MODEL are correctly injected. "
                f"stdout excerpt: {stdout[:200]}"
            )
            logger.error("worker[%s]: %s", phase, result.error)
        elif proc.returncode != 0:
            result.error = f"claude exited {proc.returncode}: {stderr[:200]}"
            logger.warning("worker[%s]: %s", phase, result.error)
        else:
            logger.debug(
                "worker[%s]: ok (%d chars stdout)", phase, len(stdout)
            )
        return result

    def _kill_container_pid(self, pid_file: str | None) -> bool:
        """Kill a specific PID inside the container by reading its pid file.

        CRITICAL for parallel explores: ``pkill -f claude`` would kill ALL
        claude processes in the container, including other explores running
        concurrently. By reading the per-session PID file and killing only
        that PID, parallel explores don't interfere with each other.
        """
        if not pid_file:
            return False
        try:
            r = subprocess.run(
                ["docker", "exec", self.container, "sh", "-c",
                 f"pid=$(cat {pid_file} 2>/dev/null); rm -f {pid_file}; "
                 f"[ -n \"$pid\" ] && kill -KILL $pid 2>/dev/null && echo killed || echo noop"],
                capture_output=True, text=True, timeout=10,
            )
            return "killed" in r.stdout
        except Exception:  # noqa: BLE001
            return False

    def write_file(self, container_path: str, content: str) -> None:
        """Write a file inside the container (used for graph.yaml injection).

        Uses ``docker exec sh -c 'cat > path'`` with content on stdin — avoids
        the tar-stream complexity of docker put_archive and works on Windows.
        Parent dirs are created first.
        """
        # mkdir -p the parent, then write via stdin to avoid shell-escaping the
        # (potentially large, YAML-containing) content.
        parent = container_path.rsplit("/", 1)[0]
        proc = subprocess.run(
            ["docker", "exec", self.container, "mkdir", "-p", parent],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"mkdir -p {parent} failed in {self.container}: {proc.stderr}")

        proc = subprocess.run(
            ["docker", "exec", "-i", self.container, "sh", "-c", f"cat > {container_path}"],
            input=content, capture_output=True, text=True, encoding="utf-8",
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"write to {container_path} failed in {self.container}: {proc.stderr}"
            )
        logger.debug("worker: wrote %d bytes to %s", len(content), container_path)

    @staticmethod
    def _redact(argv: list[str]) -> str:
        """Show the argv without dumping the full prompt (which can be huge)."""
        # The prompt is the last element after '--'; truncate it for logging.
        out = []
        for a in argv:
            if len(a) > 80:
                out.append(a[:77] + "...")
            else:
                out.append(a)
        return " ".join(out)


# --------------------------------------------------------------------------- #
# LocalWorker — runs claude directly (no docker), for hosted single-container mode
# --------------------------------------------------------------------------- #

class LocalWorker:
    """Same interface as ClaudeCodeWorker, but runs claude directly as a local
    subprocess — no docker exec wrapper.

    Used in hosted (托管) mode where the agent and claude CLI share one
    container/filesystem. The benchmark targets are reachable directly because
    the agent container's network routes to them (the platform provisions both).

    Selects via env ``WORMHOLE_WORKER_BACKEND=local`` (see ``make_worker``).
    All instance methods (execute/conclude/write_file/...) have identical
    signatures to ClaudeCodeWorker so dispatcher/tasks.py are agnostic.
    """

    def __init__(self, workdir: str = "/home/kali/workspace") -> None:
        self.workdir = workdir
        # ``container`` is kept for log-message compatibility with ClaudeCodeWorker
        # (which logs the container name); here it's just a label.
        self.container = "local"

    def execute(self, prompt: str, timeout: float) -> WorkerResult:
        """Fresh-session claude call, same semantics as ClaudeCodeWorker.execute."""
        session = str(uuid.uuid4())
        pid_file = f"/tmp/.solver-pid-{session}"
        argv = [
            "sh", "-c",
            f"cd {self.workdir} && echo $$ > {pid_file} && "
            f"exec claude --session-id {session} --dangerously-skip-permissions -p -- "
            f"\"{_escape_for_shell(prompt)}\"",
        ]
        return _run_claude_subprocess(argv, session, timeout, phase="execute", pid_file=pid_file)

    def conclude(self, prompt: str, session: str, timeout: float) -> WorkerResult:
        """Resume-session claude call, same semantics as ClaudeCodeWorker.conclude."""
        pid_file = f"/tmp/.solver-pid-{session}-conclude"
        argv = [
            "sh", "-c",
            f"cd {self.workdir} && echo $$ > {pid_file} && "
            f"exec claude -r {session} --dangerously-skip-permissions -p -- "
            f"\"{_escape_for_shell(prompt)}\"",
        ]
        return _run_claude_subprocess(argv, session, timeout, phase="conclude", pid_file=pid_file)

    def write_file(self, path: str, content: str) -> None:
        """Write a file to the local filesystem (no docker exec)."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        logger.debug("localworker: wrote %d bytes to %s", len(content), path)

    def write_progress(self, content: str) -> None:
        self.write_file(f"{self.workdir}/PROGRESS.md", content)

    def setup_team_dirs(self) -> None:
        base = Path(self.workdir)
        for d in ("team/notes", "team/findings", "solve"):
            (base / d).mkdir(parents=True, exist_ok=True)

    def check_health(self, timeout: float = 60.0) -> bool:
        """Lightweight claude probe — same logic as ClaudeCodeWorker.check_health
        but without docker exec."""
        try:
            r = _run_claude_subprocess(
                ["sh", "-c", f"cd {self.workdir} && claude --dangerously-skip-permissions -p -- 'echo ok'"],
                str(uuid.uuid4()), timeout, phase="health", pid_file=None,
            )
            return r.returncode == 0
        except Exception:  # noqa: BLE001
            return False


# ---- shared subprocess runner (used by both ClaudeCodeWorker and LocalWorker) ----

def _run_claude_subprocess(
    argv: list[str], session: str, timeout: float, *, phase: str,
    pid_file: str | None = None,
) -> WorkerResult:
    """Run a claude command (argv[0] is either 'docker' or 'sh') with a hard
    timeout and precise per-session kill.

    Extracted from ClaudeCodeWorker._run so LocalWorker can reuse the exact
    same timeout/kill/error-detection logic. The only difference between
    docker and local is the argv prefix; everything else (Popen, communicate,
    pid_file kill, auth-failure detection) is identical.
    """
    logger.debug("worker[%s]: %s (timeout=%.0fs)", phase, _redact(argv), timeout)
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    cancel_reason = ""
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            stdout, stderr = proc.communicate(timeout=5)
        except Exception:  # noqa: BLE001
            stdout, stderr = "", ""
        killed = _kill_pid_from_file(pid_file)
        cancel_reason = (
            f"timed out after {timeout:.0f}s"
            + (f" (killed PID)" if killed else " (no proc to kill)")
        )
        logger.warning("worker[%s]: %s", phase, cancel_reason)
        return WorkerResult(
            stdout=stdout or "", stderr=stderr or "",
            returncode=-1, session=session,
            timed_out=True, error=cancel_reason,
        )

    stdout = stdout or ""
    stderr = stderr or ""
    result = WorkerResult(
        stdout=stdout, stderr=stderr,
        returncode=proc.returncode, session=session,
    )
    if any(marker in stdout or marker in stderr for marker in _AUTH_FAILURE_MARKERS):
        result.error = (
            f"claude auth failure. Check that "
            f"ANTHROPIC_AUTH_TOKEN/BASE_URL/MODEL are correctly set. "
            f"stdout excerpt: {stdout[:200]}"
        )
        logger.error("worker[%s]: %s", phase, result.error)
    elif proc.returncode != 0:
        result.error = f"claude exited {proc.returncode}: {stderr[:200]}"
        logger.warning("worker[%s]: %s", phase, result.error)
    else:
        logger.debug("worker[%s]: ok (%d chars stdout)", phase, len(stdout))
    return result


def _kill_pid_from_file(pid_file: str | None) -> bool:
    """Kill the PID recorded in ``pid_file``. Works for both docker (via
    docker exec) and local (direct os.kill) modes.

    CRITICAL for parallel explores: kills ONLY this session's process, not
    all concurrent claude processes.

    Cross-platform: uses SIGKILL on Linux/Mac (the hosted target), falls back
    to SIGTERM on Windows (where SIGKILL doesn't exist).
    """
    if not pid_file:
        return False
    try:
        content = Path(pid_file).read_text().strip()
        Path(pid_file).unlink(missing_ok=True)
        if content and content.isdigit():
            sig = getattr(signal, "SIGKILL", signal.SIGTERM)
            os.kill(int(content), sig)
            return True
    except (OSError, ValueError):
        pass
    return False


def _redact(argv: list[str]) -> str:
    """Show argv without dumping the full prompt (truncated for logging)."""
    out = []
    for a in argv:
        out.append(a[:77] + "..." if len(a) > 80 else a)
    return " ".join(out)


# ---- worker factory: selects docker vs local based on env ----

def make_worker(container_or_code: str, workdir: str = "/home/kali/workspace"):
    """Return a ClaudeCodeWorker (docker backend) or LocalWorker (local backend).

    Backend selection: env ``WORMHOLE_WORKER_BACKEND=local`` → LocalWorker.
    Default (unset or ``docker``) → ClaudeCodeWorker (existing behavior).

    This lets the hosted single-container image flip to local mode without
    touching cli_solve/dispatcher/tasks code — they just get a worker object
    with the same interface.
    """
    if os.environ.get("WORMHOLE_WORKER_BACKEND", "docker") == "local":
        return LocalWorker(workdir)
    return ClaudeCodeWorker(container_or_code, workdir)


def ensure_container(name: str, image: str, env: WorkerEnv, *, network: str = "host",
                     skills_dir: str | None = None) -> str:
    """Module-level dispatch: docker ensure_container or local no-op.

    In local mode, the 'container' is the running process itself — nothing to
    start. We just ensure the workdir exists.
    """
    if os.environ.get("WORMHOLE_WORKER_BACKEND", "docker") == "local":
        Path("/home/kali/workspace").mkdir(parents=True, exist_ok=True)
        return name
    return ClaudeCodeWorker.ensure_container(name, image, env, network=network, skills_dir=skills_dir)


def detect_external_ip(name: str, timeout: float = 15.0) -> str | None:
    """Module-level dispatch: docker detect_external_ip or local curl."""
    if os.environ.get("WORMHOLE_WORKER_BACKEND", "docker") == "local":
        for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://4.ipw.cn"):
            try:
                r = subprocess.run(
                    ["curl", "-s", "--max-time", "8", url],
                    capture_output=True, text=True, timeout=timeout,
                )
                ip = r.stdout.strip()
                if r.returncode == 0 and ip and _looks_like_ip(ip):
                    logger.info("localworker: detected external IP %s (via %s)", ip, url)
                    return ip
            except (subprocess.TimeoutExpired, Exception):  # noqa: BLE001
                continue
        return None
    return ClaudeCodeWorker.detect_external_ip(name, timeout)


def remove_container(name: str) -> None:
    """Module-level dispatch: docker remove_container or local no-op."""
    if os.environ.get("WORMHOLE_WORKER_BACKEND", "docker") == "local":
        return  # nothing to remove — we ARE the container
    ClaudeCodeWorker.remove_container(name)


# --------------------------------------------------------------------------- #
# Module-level helpers
# --------------------------------------------------------------------------- #

def _to_docker_path(host_path: str) -> str:
    """Convert a Windows host path to a Docker-CLI-compatible bind path.

    Docker Desktop on Windows accepts forward-slash paths (``C:/Users/...``).
    Git Bash sometimes mangles ``C:\\`` into ``/c/`` via MSYS path conversion —
    Docker understands ``C:/`` directly, so normalize to that form.
    """
    p = str(host_path).replace("\\", "/")
    # MSYS /c/... → C:/...
    if len(p) >= 3 and p[0] == "/" and p[2] == "/" and p[1].isalpha():
        p = p[1].upper() + ":" + p[2:]
    return p


def _looks_like_ip(text: str) -> bool:
    """Cheap check that ``text`` is an IP, not an error HTML page."""
    s = text.strip()
    if not s or len(s) > 45 or " " in s or "<" in s:
        return False
    parts = s.split(".")
    if len(parts) == 4:  # IPv4
        return all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)
    return ":" in s  # IPv6 rough check


def _escape_for_shell(text: str) -> str:
    """Escape a string for safe embedding inside double-quotes in a sh -c command.

    Used when we wrap ``claude ... -- "<prompt>"`` inside ``sh -c 'echo $$ > pidfile
    && exec claude ...'``. The prompt is already inside double-quotes in the shell
    command, so we only need to escape ``$``, ``"``, ``\\``, and backticks.
    """
    # Escape backslash first (order matters), then the others.
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`")
