---
name: wormhole-finding-report
description: Compose and save a English Markdown detailed report based on the original evidence, execution trace and current evidence version of the registered vulnerability, without re-detecting the target.
---

# Evidenced vulnerability reports

First read the trigger context and distinguish the numbers:

- finding_id: Individual vulnerability record ID, used for get_finding_traffic / bind_finding_traffic.
- finding_node_id (or discovery node id): used in get_task_node_detail/node_detail, and the finding_id parameter of update_finding_report.

Do not guess the number or interchange the two. Read the node and visible worker trace to understand the preconditions, get_finding_traffic(finding_id) to obtain the evidence list and version; actually read the request/response when there is binding. Empty lists are OK, command/non-HTTP evidence can be independently supported reporting, subject to stated limitations.

## Report

Written as [references/report.md](${SKILL_DIR}/references/report.md): Overview, Scope/Identity, Impact, Reproduction Steps, Baseline/Negative Controls, Evidence, PoC, Root Cause & Fix, Validation Limitations. Only quote what was actually read. Placeholders are used for sensitive credentials and the original content remains in the controlled evidence module.

When CVSS 3.1 base scoring is required and the local execution tool is available for the current session, run:

    node "${SKILL_DIR}/scripts/cvss31.mjs" "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N"

Select the vector based on actual permissions, interactions, attack conditions and direct impact; the calculator only calculates, not determines the impact. Explicitly not score when there is no enforcement tool or insufficient evidence, and do not fabricate calculation results or escalate severity.

## Save

Call update_finding_report(finding_id=discovery node ID, report=Markdown full text, evidence_version=actually read version). When there is a version conflict, the evidence and version must be re-read and revised. It cannot be overwritten by just changing the version number. The report will be saved only after the tool returns success.

This role will not attack targets again, create duplicate vulnerabilities, or add candidate vulnerabilities as confirmed vulnerabilities. When there is insufficient evidence support, the gap will be explained in the report and no reproduction results will be fabricated to complete the report.
