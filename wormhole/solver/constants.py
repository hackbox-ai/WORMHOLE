"""Shared constants — no dependencies on other solver modules.

This module exists to break circular imports:
  - dispatcher.py needs FLAG_RE (was importing from cli_solve)
  - tasks.py needs _build_progress (was importing from cli_solve)
  - cli_solve.py imports dispatcher and tasks

By putting FLAG_RE and dead-end markers here, dispatcher/tasks/cli_solve/webui
can all import from this zero-dependency module without circularity.
"""
from __future__ import annotations

import re


class WorkerConfigError(RuntimeError):
    """Raised when LLM worker configuration (token/base_url) is missing.

    A ``RuntimeError`` subclass (not ``sys.exit``) so library callers like
    the webui can catch it via ``except Exception`` instead of having the
    whole process killed by an unhandled ``SystemExit`` (which inherits
    from ``BaseException``, not ``Exception``).
    """


# Flag regex — matches flag{...} with body length 1-4090 (any case).
# Used by: cli_solve (extraction), dispatcher (flag counting), webui (display).
FLAG_RE = re.compile(r"(?i)flag\{(?P<body>[^}]{1,4090})\}")

# Dead-end / negative-conclusion markers for fact descriptions.
# Used by: cli_solve (_extract_prior_experience), webui (_extract_dead_ends).
# These must be STRONG signals — not just "not" appearing anywhere.
# When a dead-end phrase is present, it takes priority over positive signals
# in the SAME sentence (a fact saying "ruled out SSRF" is a dead end even if
# it also contains the word "credential" elsewhere).
DEAD_END_PHRASES = (
    "not injectable", "no injection point", "ruled out", "dead end",
    "fully exhausted", "not vulnerable", "confirmed non-functional",
    "not exploitable", "no route to host", "unreachable",
    "connection refused", "connection timed out",
    "could not be executed", "no valid credentials",
    "does not exist", "does not work",
    "all attempts failed", "impossible to",
    "blocked by", "not accessible",
    "no flag found", "flag not found", "flag not captured",
    "exhausted all", "no new findings", "zero results",
)

# STRONG positive signals — a fact with these is a real finding, not a dead end.
# Each phrase is specific enough that it cannot appear inside a negative sentence
# by accident. Generic verbs ("obtained", "discovered", "pivot", "credential")
# are deliberately excluded because they appear in negative contexts too:
#   - "no valid credentials"  (contains "credential")
#   - "pivot host unreachable" (contains "pivot")
#   - "discovered that X is not vulnerable" (contains "discovered")
# NOTE: avoid bare "valid credential" — it is a substring of
# "no valid credentials" (the dead-end phrase). Use the full phrase instead.
POSITIVE_SIGNALS = (
    "flag{", "flag captured", "flag submitted", "flag accepted",
    "confirmed working", "successfully exploited", "successful exploitation",
    "breakthrough", "rce confirmed", "code execution confirmed",
    "password found", "credential obtained", "credential works",
    "api key obtained", "session forged",
    "admin access", "logged in as", "login succeeded",
    "webshell", "web shell", "shell access", "foothold established",
    "successful pivot", "pivot succeeded",
    "identified vulnerability", "vulnerability confirmed",
)
