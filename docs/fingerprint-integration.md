# Fingerprint adaptation

WORMHOLE retains rule management, data import and export, matching engine invocation, task-level materials and snapshots, identification evidence and planning linkage.

The basic version does not carry a complete rule base or matching engine, and does not automatically import data at startup. For installation and configuration, see [Optional Extensions](extensions.md). Rules can still be managed without an engine. Recognition will only be performed when an installed engine and valid rules exist.

Code entry:`pihost/src/domains/fingerprints/`,`pihost/fingerprint-engine/`,`pihost/src/api/fingerprints.ts`.

Rule revisions and task snapshots are saved separately; the actual identification results are product clues and cannot be directly used as vulnerability evidence.
