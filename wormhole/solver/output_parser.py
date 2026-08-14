"""Tolerant JSON extraction from a worker CLI's stdout.

Direct port of Cairn's ``cairn.dispatcher.output_parser`` — the worker
(claude code in ``-p`` print mode) emits plain text that *contains* a JSON
object, sometimes wrapped in prose or a fenced code block. This module finds
the first valid JSON object in that text.

Strategy (three layers, increasingly lenient):
  1. Try ``json.loads`` on the whole stripped text.
  2. Pull out fenced code blocks (```json ... ```) and try each.
  3. Scan every ``{`` position and ``JSONDecoder.raw_decode`` from there.

Raises ``ValueError`` if no JSON object is found — the caller treats that as
"worker produced unusable output" and triggers the conclude fallback.
"""
from __future__ import annotations

import json
import re
from typing import Any

# Matches ```json\n ... ``` or ```\n ... ``` (DOTALL so newlines are included).
FENCED_BLOCK_RE = re.compile(r"```(?:json)?\s*\n?(.*?)```", re.IGNORECASE | re.DOTALL)


def extract_json_object(text: str) -> dict[str, Any]:
    """Return the first JSON object found anywhere in ``text``.

    Raises ``ValueError`` if none is found.
    """
    decoder = json.JSONDecoder()
    seen: set[str] = set()

    for candidate in _candidate_segments(text):
        segment = candidate.strip()
        if not segment or segment in seen:
            continue
        seen.add(segment)

        # Layer 1: the whole segment is a JSON object.
        try:
            parsed = json.loads(segment)
        except json.JSONDecodeError:
            pass
        else:
            if isinstance(parsed, dict):
                return parsed

        # Layer 3: scan from each '{' for a valid prefix JSON object.
        for start in _object_start_positions(segment):
            try:
                parsed, _end = decoder.raw_decode(segment[start:])
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed

    raise ValueError("no JSON object found in output")


def _candidate_segments(text: str) -> list[str]:
    """Whole text first, then every fenced code block."""
    segments = [text.strip()]
    segments.extend(match.group(1).strip() for match in FENCED_BLOCK_RE.finditer(text))
    return segments


def _object_start_positions(text: str) -> list[int]:
    return [index for index, char in enumerate(text) if char == "{"]
