"""TSec Benchmark Platform API client.

Thin synchronous wrapper over the five §5 endpoints. Kept synchronous on
purpose: the benchmark protocol is strictly sequential per challenge
(start → pwn → submit → close) and a single requests.Session reuses the
connection pool cheaply. The async orchestration in ``runner.py`` calls these
from a thread executor so the network waits never block the event loop.

See the Challenges API doc (pasted as paste-attachments/...-6a6b8378.txt):
    §5.1 GET    /openapi/v1/challenges
    §5.2 POST   /openapi/v1/challenges/start
    §5.3 GET    /openapi/v1/challenges/hint
    §5.4 POST   /openapi/v1/challenges/submit
    §5.5 POST   /openapi/v1/challenges/close
"""
from __future__ import annotations

import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

# Error codes from §4.2. Lifted to class attributes so callers can do
# ``except ChallengeError as e: if e.is_task_ended(): ...`` without memorizing
# strings.
CODE_TASK_NOT_FOUND = "task_not_found"
CODE_CHALLENGE_NOT_FOUND = "challenge_not_found"
CODE_INVALID_STATE = "invalid_state"          # task ended (timeout/manual stop)
CODE_DUPLICATE = "duplicate"                    # same flag re-submitted (idempotent OK)
CODE_RESOURCE_UNAVAILABLE = "resource_unavailable"
CODE_INTERNAL_ERROR = "internal_error"

# Codes that mean "no point continuing with ANY challenge on this task".
_TASK_ENDED_CODES = frozenset({CODE_TASK_NOT_FOUND, CODE_INVALID_STATE})


class ChallengeError(RuntimeError):
    """A benchmark business error (§4.1 JSON envelope).

    ``code`` is the machine-readable error code; ``http_status`` the HTTP code;
    ``detail`` carries anything extra the platform returned.
    """

    def __init__(self, code: str, message: str, *, http_status: int = 0, detail: Any = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.http_status = http_status
        self.detail = detail or {}

    def is_task_ended(self) -> bool:
        """True if the whole run is over (token bad or task timed out)."""
        return self.code in _TASK_ENDED_CODES

    def is_duplicate(self) -> bool:
        """True if this was an idempotent re-submit of an already-correct flag."""
        return self.code == CODE_DUPLICATE

    def is_transient(self) -> bool:
        """True for errors worth retrying after a short backoff."""
        return self.code in {CODE_RESOURCE_UNAVAILABLE, CODE_INTERNAL_ERROR}


class BenchmarkClient:
    """Client for the TSec Benchmark Platform Challenges API.

    Construction needs the two values the platform hands out when you create a
    scoring task: ``base_url`` (the BENCHMARK_BASE_URL) and ``token``
    (BENCHMARK_TOKEN). Both also accept env-var fallback for headless use.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
        session: requests.Session | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._session = session or requests.Session()
        # §1: every /openapi/v1/challenges/* call is authed by this header.
        self._session.headers.update({"BENCHMARK_TOKEN": token})

    # ---- internal helpers -------------------------------------------------

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        """Issue a request and unwrap the §4 envelope.

        - 2xx → parsed JSON body (or {} on empty)
        - 4xx/5xx with a business envelope → ``ChallengeError``
        - 422 FastAPI validation error → ``ChallengeError`` (code=validation_error)
          so callers see a uniform exception shape
        - transport failure → ``ChallengeError`` (code=transport_error)
        """
        try:
            resp = self._session.request(
                method, self._url(path), timeout=self.timeout, **kwargs
            )
        except requests.RequestException as exc:
            raise ChallengeError(
                "transport_error", f"network error: {exc}", http_status=0
            ) from exc

        # Empty/204 responses (close can be minimal) → treat as success.
        if resp.status_code == 204 or not resp.content:
            return {}

        try:
            body = resp.json()
        except ValueError:
            # Non-JSON body — surface raw text for debugging.
            raise ChallengeError(
                "transport_error",
                f"non-JSON response ({resp.status_code}): {resp.text[:200]}",
                http_status=resp.status_code,
            ) from None

        if 200 <= resp.status_code < 300:
            return body

        # Business error envelope per §4.1: {code, message, detail}
        if isinstance(body, dict) and "code" in body:
            raise ChallengeError(
                body["code"],
                body.get("message", ""),
                http_status=resp.status_code,
                detail=body.get("detail"),
            )

        # §4.3 framework validation error: FastAPI detail list, no `code`.
        if resp.status_code == 422:
            raise ChallengeError(
                "validation_error",
                f"422 validation error: {body}",
                http_status=422,
                detail=body,
            )

        # Unknown shape — still raise so the caller sees the status.
        raise ChallengeError(
            "unknown_error",
            f"unexpected {resp.status_code}: {body}",
            http_status=resp.status_code,
            detail=body,
        )

    # ---- §5.1 list challenges --------------------------------------------

    def list_challenges(self) -> list[dict[str, Any]]:
        """§5.1 GET /openapi/v1/challenges — list all challenges + progress.

        Each item carries ``unique_code``, ``flag_count``, ``is_completed``,
        ``container_status``, ``container_addr`` etc. Used to plan the run.
        """
        data = self._request("GET", "/openapi/v1/challenges")
        if not isinstance(data, list):
            raise ChallengeError(
                "unknown_error",
                f"expected a list from /challenges, got {type(data).__name__}",
                detail=data,
            )
        return data

    # ---- §5.2 start container --------------------------------------------

    def start(self, unique_code: str) -> list[str]:
        """§5.2 POST /openapi/v1/challenges/start — boot a challenge container.

        Returns the ``container_addr`` list (IP:port strings). Empty list means
        the container isn't ready yet — the runner polls or backs off.
        Raises ``ChallengeError(invalid_state)`` if the 3-container cap is hit.
        """
        body = self._request(
            "POST",
            "/openapi/v1/challenges/start",
            params={"unique_code": unique_code},
        )
        addrs = (body or {}).get("container_addr", []) if isinstance(body, dict) else []
        return list(addrs)

    # ---- §5.3 hint --------------------------------------------------------

    def hint(self, unique_code: str) -> str | None:
        """§5.3 GET /openapi/v1/challenges/hint — fetch a hint (COSTS score).

        Only call when truly stuck; per §3 the flag score is then reduced by
        ``hint_cost_ratio``. Returns the hint text or None if there is none.
        """
        body = self._request(
            "GET",
            "/openapi/v1/challenges/hint",
            params={"unique_code": unique_code},
        )
        return (body or {}).get("hint") if isinstance(body, dict) else None

    # ---- §5.4 submit flag -------------------------------------------------

    def submit(self, unique_code: str, flag: str) -> dict[str, Any]:
        """§5.4 POST /openapi/v1/challenges/submit — submit a flag.

        Returns the verdict dict: ``correct``, ``awarded``, ``cumulative_score``,
        ``correct_flag_count``, ``total_flag_count``, ``matched_flag_index``.
        A duplicate re-submit raises ``ChallengeError(duplicate)`` — the runner
        treats that as success (idempotent, §3) and moves on.
        """
        body = self._request(
            "POST",
            "/openapi/v1/challenges/submit",
            json={"unique_code": unique_code, "flag": flag},
        )
        return body or {}

    # ---- §5.5 close container --------------------------------------------

    def close(self, unique_code: str) -> bool:
        """§5.5 POST /openapi/v1/challenges/close — release a container.

        Must be called for every started challenge to free the 3-container
        budget. Safe to call even if start/submit failed — the platform is
        idempotent about already-closed containers.
        """
        try:
            body = self._request(
                "POST",
                "/openapi/v1/challenges/close",
                params={"unique_code": unique_code},
            )
            return bool((body or {}).get("closed", True))
        except ChallengeError as exc:
            # Closing is best-effort cleanup. Log but don't propagate — the
            # runner calls this from ``finally`` and a raise there masks the
            # real error from the try-block.
            logger.warning("close(%s) failed (%s): %s", unique_code, exc.code, exc)
            return False

    # ---- convenience ------------------------------------------------------

    def is_task_active(self) -> bool:
        """Cheap liveness probe: returns True iff list_challenges works."""
        try:
            self.list_challenges()
            return True
        except ChallengeError as exc:
            if exc.is_task_ended():
                return False
            # Transient errors don't prove the task ended — be optimistic.
            logger.warning("is_task_active: %s (assuming still active)", exc)
            return True
