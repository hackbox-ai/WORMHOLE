"""Wormhole orchestrator: benchmark platform API client.

This package is Qt-free so it can run headless in a benchmark container:

    BenchmarkClient  -- thin HTTP wrapper over the platform's
                        challenge/submit/close endpoints (§5.1~§5.5)
"""
from wormhole.orchestrator.benchmark_client import BenchmarkClient, ChallengeError

__all__ = [
    "BenchmarkClient",
    "ChallengeError",
]
