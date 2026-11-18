---
name: wormhole-test-plan
description: Verifiable target disassembly, hypothesis-driven planning, coverage and failed path deduplication for security testing. For use by Goals/Planner, relies on WORMHOLE exploration graph, does not perform network detection.
---

# Test planning

First divide the work according to the current role: Goals only extracts goals/constraints; Planner reads the persistent exploration graph and dispatches intentions. Use the real scope and budget of the task as boundaries, and do not start independent schedulers, SQLite state libraries or infinite "free jumps".

## Goals

- Turn user requirements into verifiable end results, such as "Verify object isolation between two test identities and deliver proof of control" instead of "Run a scanner".
- set_goals preserves user goals and does not add forced vulnerability numbers; allows completion without confirming vulnerabilities.
- set_constraints only enters the allow/deny explicitly given by the user, and does not disguise method suggestions as user authorization.
- Make it clear when there are gaps in the scope, identity, files, request/time budget, and stopping conditions, and do not expand the target on your own.

## Planner

1. Read graph_overview, list_goals, list_facts; if necessary, node_detail/expand_digest gets the details. Existing assets, execution intent, failure paths, and associated tasks are all considered.
2. Generate hypotheses from business objects and trust boundaries: the subject should not be able to perform what operations on which objects, what is the expected basis, what are the current evidence and gaps.
3. The summary of each add_intent states the goal, hypothesis, control variables, observable criteria, boundaries and stopping conditions; the schema does not have parameters such as hypothesis, and fields are not added out of thin air. Already records are linked with real parent_ids/asset_ids.
4. Establish an applicable coverage matrix of "Special Type × Operation × Parameter Position × Identity/Object" by business: authentication/binding change chain, object/tenant matrix, JS signature restoration, query of all relevant filter fields, upload processing chain, URL callback, business status/race status, etc. Unknown types are detected first, and all vulnerabilities are not blindly listed; one GET or one scan cannot cover the entire row.
5. When there is an identity, priority is given to object isolation from tenants and field-level writing/status; when there is no identity, priority is given to the real business entrance, authentication chain and JS request restoration. Select special projects based on real clues; public directories/versions/HTML return packages are not found to be up to standard.
6. Give priority to directions that can change conclusions, supplement key coverage, remove dependencies and have low request costs. A round with a small number of independent intentions; the serial chain only sends pre-existing steps. Worker executes the matching method in the skill index, and the summary indicates which specialization to read and the normal/experimental/control criteria.
7. Do not repeatedly dispatch executed directions with the same subject, object, parameters and mechanism. Stopping this hypothesis with no gain in two rounds does not mean that the entire task is only tested three times; it will only be restarted with new identities, new interfaces, configuration changes, or new evidence. Network observations are separated from verified coverage.

For coverage judgment, intention handover fields and reopening conditions, see [references/planning.md](${SKILL_DIR}/references/planning.md), which can be read when complex tasks occur.

## End judgment

Capturing traffic, downloading JS, intent done, and candidate appearance do not mean that the goal has been achieved. prove_goal only when real facts/findings are enough to prove a certain goal; the end of this round of planning cannot be regarded as the end of the entire task. Uncovered items record BLOCKED/DEFERRED and specific conditions to keep the facts consistent with the target state. The host does not send new directions after pause, cancellation, and timeout.
