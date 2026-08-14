"""Validation of worker JSON payloads (the OODA output protocol).

Direct port of Cairn's ``cairn.dispatcher.contracts``. Each task type has a
``validate_*`` function that takes the parsed JSON dict and returns a
``(kind, data)`` tuple:

  kind        meaning                       data
  ----        -------                       ----
  "complete"  goal is met                   complete dict / fact info
  "intents"   new intents to explore        list of intent dicts
  "fact"      a new confirmed fact          fact description string
  "noop"      nothing to do this round      None
  "rejected"  worker refused the task       None

Workers are encouraged to wrap their payload as ``{"accepted": true, "data":
{...}}``, but we also accept the bare data dict for robustness (LLMs don't
always follow the envelope).
"""
from __future__ import annotations

from typing import Any

from wormhole.solver.output_parser import extract_json_object


def parse_json_output(stdout: str) -> dict[str, Any]:
    """Parse worker stdout into a dict (raises ValueError if no JSON)."""
    return extract_json_object(stdout)


# --------------------------------------------------------------------------- #
# Envelope handling
# --------------------------------------------------------------------------- #

def _unwrap_wrapped_payload(payload: dict[str, Any]) -> tuple[bool | None, dict[str, Any] | None]:
    """Strip the ``{accepted, data}`` envelope if present.

    Returns ``(accepted, data)`` where ``accepted`` is True/False when the
    envelope was used, or ``(None, None)`` when the payload is bare (caller
    then validates the shape directly).
    """
    accepted = payload.get("accepted")
    if accepted is False:
        return False, None
    if accepted is True:
        data = payload.get("data")
        if not isinstance(data, dict):
            raise ValueError("data must be an object")
        return True, data
    return None, None


def _is_dict(value: Any) -> bool:
    return isinstance(value, dict)


# --------------------------------------------------------------------------- #
# Shape sniffers (for bare payloads without the envelope)
# --------------------------------------------------------------------------- #

def _looks_like_reason_data(payload: dict[str, Any]) -> bool:
    keys = set(payload)
    if keys == {"complete"}:
        complete = payload["complete"]
        return isinstance(complete, dict) and "from" in complete and "description" in complete
    if keys == {"intents"}:
        return isinstance(payload["intents"], list)
    if keys == {"intent"}:  # singular back-compat
        intent = payload["intent"]
        return isinstance(intent, dict) and "from" in intent and "description" in intent
    return False


def _looks_like_bootstrap_execute_data(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict) or set(payload) != {"fact", "complete"}:
        return False
    return _is_dict(payload.get("fact")) and _is_dict(payload.get("complete"))


def _looks_like_bootstrap_conclude_data(payload: dict[str, Any]) -> bool:
    keys = set(payload)
    if keys not in ({"fact"}, {"fact", "complete"}):
        return False
    return _is_dict(payload.get("fact"))


def _looks_like_explore_data(payload: dict[str, Any]) -> bool:
    return isinstance(payload, dict) and set(payload) == {"description"}


# --------------------------------------------------------------------------- #
# Public validators — one per task type
# --------------------------------------------------------------------------- #

def validate_reason_payload(
    payload: dict[str, Any], open_intents_empty: bool, max_intents: int,
) -> tuple[str, dict[str, Any] | list[dict[str, Any]] | None]:
    """Validate a reason-task payload.

    Returns one of:
      ("complete",  {from:[...], description})  — goal is met
      ("intents",   [{from,description}, ...])  — new intents to create
      ("noop",      None)                        — nothing to do
      ("rejected",  None)                        — worker refused
    """
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_reason_data(payload):
            raise ValueError("accepted must be true or false")
        data = payload
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")

    complete = data.get("complete")
    intents = data.get("intents")
    # Backward compat: accept singular "intent" key.
    if intents is None:
        singular = data.get("intent")
        if isinstance(singular, dict):
            intents = [singular]

    if complete is not None:
        if intents is not None:
            raise ValueError("complete and intents cannot coexist")
        if not isinstance(complete, dict) or "from" not in complete or "description" not in complete:
            raise ValueError("invalid complete payload")
        return "complete", complete

    if intents is not None:
        if not isinstance(intents, list):
            raise ValueError("intents must be an array")
        for i, intent in enumerate(intents):
            if not isinstance(intent, dict) or "from" not in intent or "description" not in intent:
                raise ValueError(f"invalid intent at index {i}")
        if not intents and open_intents_empty:
            raise ValueError("intents must not be empty when open_intents is empty")
        intents = intents[:max_intents]
        if not intents:
            return "noop", None
        return "intents", intents

    # Neither complete nor intents.
    if open_intents_empty:
        raise ValueError("intents is required when open_intents is empty")
    return "noop", None


def validate_bootstrap_execute_payload(payload: dict[str, Any]) -> tuple[str, dict[str, str] | None]:
    """Validate a bootstrap execute payload → ("complete", {fact_description, complete_description})."""
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_bootstrap_execute_data(payload):
            raise ValueError("accepted must be true or false")
        data = payload
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")

    fact = data.get("fact")
    if not isinstance(fact, dict):
        raise ValueError("fact is required")
    fact_description = fact.get("description")
    if not isinstance(fact_description, str) or not fact_description.strip():
        raise ValueError("fact.description is required")

    result: dict[str, str] = {"fact_description": fact_description.strip()}
    complete = data.get("complete")
    if complete is None:
        raise ValueError("complete is required")
    if not isinstance(complete, dict):
        raise ValueError("complete must be an object")
    complete_description = complete.get("description")
    if not isinstance(complete_description, str) or not complete_description.strip():
        raise ValueError("complete.description is required")
    result["complete_description"] = complete_description.strip()
    return "complete", result


def validate_bootstrap_conclude_payload(payload: dict[str, Any]) -> tuple[str, str | None]:
    """Validate a bootstrap conclude payload → ("fact", description) or ("rejected", None)."""
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_bootstrap_conclude_data(payload):
            raise ValueError("accepted must be true or false")
        data = payload
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")

    extra_keys = set(data) - {"fact", "complete"}
    if extra_keys:
        raise ValueError("unexpected keys in conclude payload")
    fact = data.get("fact")
    if not isinstance(fact, dict):
        raise ValueError("fact is required")
    fact_description = fact.get("description")
    if not isinstance(fact_description, str) or not fact_description.strip():
        raise ValueError("fact.description is required")
    return "fact", fact_description.strip()


def validate_explore_payload(payload: dict[str, Any]) -> tuple[str, str | None]:
    """Validate an explore (or explore conclude) payload → ("fact", description)."""
    accepted, data = _unwrap_wrapped_payload(payload)
    if accepted is False:
        return "rejected", None
    if accepted is None:
        if not _looks_like_explore_data(payload):
            raise ValueError("accepted must be true or false")
        data = payload
    if not isinstance(data, dict):
        raise ValueError("accepted must be true or false")
    description = data.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("description is required")
    return "fact", description.strip()
