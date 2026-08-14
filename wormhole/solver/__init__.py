"""Wormhole solver: a Cairn-style general problem-solving engine.

Drives the TSec Benchmark through a blackboard (Fact/Intent/Hint DAG) and an
OODA loop (bootstrap → reason → explore) executed by a worker (claude code
running inside a Kali container). Qt-free and standalone — solves any
challenge type the worker's CLI agent + container tools can handle.

See wormhole/solver/README.md (if present) and the design notes in each module.
"""
from wormhole.solver.blackboard import Blackboard, Fact, Hint, Intent
from wormhole.solver.contracts import (
    validate_bootstrap_conclude_payload,
    validate_bootstrap_execute_payload,
    validate_explore_payload,
    validate_reason_payload,
)
from wormhole.solver.output_parser import extract_json_object

__all__ = [
    "Blackboard",
    "Fact",
    "Hint",
    "Intent",
    "extract_json_object",
    "validate_bootstrap_conclude_payload",
    "validate_bootstrap_execute_payload",
    "validate_explore_payload",
    "validate_reason_payload",
]
