"""Prompt loading, rendering, and graph-snapshot file injection.

Direct port of Cairn's ``prompting.py`` mechanics:
  - Templates are plain markdown with ``{placeholder}`` tokens.
  - Rendering is naive ``str.replace`` (NOT Jinja/f-string) so the placeholders
    are literal braces in the .md files — safe to edit without escaping.
  - The graph YAML is too large to inline, so it's written to a file *inside
    the worker container* and the prompt just references the path. The worker
    (claude code) reads the file itself.

The only divergence from Cairn: Cairn writes the graph via docker's tar
``put_archive`` API; here we delegate to the worker's ``write_file`` which can
use whichever transport the worker implementation prefers.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent / "prompts"


def load_template(name: str) -> str:
    """Read a prompt markdown file by stem (e.g. 'bootstrap' → bootstrap.md)."""
    path = _PROMPTS_DIR / f"{name}.md"
    return path.read_text(encoding="utf-8")


def render(template: str, replacements: dict[str, str]) -> str:
    """Substitute ``{key}`` → value for every key in ``replacements``.

    Naive string replacement, matching Cairn's approach. Any ``{key}`` not in
    the replacements dict is left as-is (so templates can contain literal
    braces in code examples without special handling).
    """
    out = template
    for key, value in replacements.items():
        out = out.replace("{" + key + "}", value)
    return out


def format_json(value) -> str:
    """Pretty-print as 2-space JSON (for hints/open-intents injection)."""
    return json.dumps(value, ensure_ascii=False, indent=2)


def inject_graph_reference(template: str, graph_yaml: str, worker) -> str:
    """Write the graph YAML into the worker container, return the rendered prompt.

    Replaces the ``{graph_reference}`` placeholder with a short instruction
    pointing the worker at the file we just wrote. This keeps the prompt small
    even when the graph grows large. Synchronous — the caller may wrap it in
    ``asyncio.to_thread`` if the write is slow.
    """
    phase = uuid.uuid4().hex[:12]
    file_path = f"/tmp/solver-prompts/{phase}/graph.yaml"
    worker.write_file(file_path, graph_yaml)
    reference = (
        f"The graph YAML snapshot is stored in this file inside the current container:\n\n"
        f"{file_path}\n\n"
        f"Before using the graph, read the entire file and treat its contents as the YAML "
        f"snapshot for the Graph section."
    )
    return render(template, {"graph_reference": reference})
