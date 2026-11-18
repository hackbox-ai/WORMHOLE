---
name: wormhole-test-method
description: Web/API special testing: object and tenant permission matrix, JS interface and signature restoration, authentication filter layer identification, injection, upload, SSRF, authentication chain and business competition. Worker/Pentest reads specific steps, controls, and criteria based on interface characteristics, and writes them back to WORMHOLE.
---

# Evidence-driven testing

To execute the current intention or clear task, first read the operational constraints, existing facts and relevant evidence. Only the tools actually provided by the current session are called; permissions, approvals, pauses, cancellations, and deadlines are controlled by the host and cannot be bypassed by external scripts or MCPs.

## Minimum verification loop

1. **Hypothesis**: Who should not do anything to which object? What is the basis for normal behavior?
2. **Baseline**: Valid identity + own test object/legal input, confirm that the business entrance and environment are normal.
3. **Experiment**: Change only one identity, object, parameter, or boundary at a time; define criteria, request budget, and stopping conditions for each hypothesis. Baseline/experiment/negative control is an experimental unit, not that the entire task can only send three requests; the applicable type, parameter location and business operation need to be covered separately.
4. **Negative control**: Use random non-existent objects/unauthorized subjects and other controls for enumeration, difference, and ultra vires conclusions to exclude current limiting, caching, template return packets, and environmental noise.
5. **Judgment**: Observation does not equal vulnerability, ability does not equal impact; insufficient evidence to record candidate/blocking, registration and discovery only when true cross-border is established.
6. **Write back**: Save the increment in time and then end the current intention. When there is no new information, there will be no infinite retry and no expansion to new targets.

## Select specific methods by characteristics

Read [Special Index](${SKILL_DIR}/references/web-tests.md) first, and only load methods matching the current entry. The normal baseline, univariate experiment, negative control and actual effect verification of the method must be performed, and the vulnerability name cannot be listed only.

- SPA, dynamic chunk, sign/nonce, encrypted ID, unlisted addresses and high-entropy path segments: JS interface and signature restoration.
- User/Tenant/Order/Attachment ID, Export, Admin Fields: Object Authorization Matrix, Batch Assignment.
- 401/403/405, routing variant 200, request body 400: filter and controller hierarchical discrimination.
- Query filtering, templates, system command parameters: select query/template/command methods according to real language.
- URL import/preview/callback, upload and signed address, browser output: SSRF, upload chain, XSS.
- Service account credentials under login/password change/binding, JWT/OAuth, WebAuthn, SMS email, throttling: corresponding authentication chain.
- Lack of test identity, robots banned directory, archive migration traces: deployment legacy and identity clues, connecting authentication chain candidate derivation.
- Payment/voucher/points/state transition: business invariants and small concurrency race conditions.
- Use after storage, asynchronous tasks, derived download credentials, tenant switching or accumulated credit: load [Process and Status Analysis] (${SKILL_DIR}/references/workflow-analysis.md) to establish cross-step relationships and final status criteria; use its offline correlation, matrix, difference and constraint calculation tools as needed.
- GraphQL/WebSocket, proxy cache, XML/serialization, cloud assistant: corresponding protocol methods.

Read [evidence specification](${SKILL_DIR}/references/evidence.md) to close the evidence. Complex objects check reading, writing, sub-resources, field leaks and state transitions respectively; a GET conclusion cannot replace the entire business chain.

## Tools and request construction

http_request only supports the url/method/body of the actual schema and cannot invent headers. When Cookie, Authorization, origin path, binary or protocol level control is required, use a currently authorized and actually available browser/MCP or Bash client; comply with the host's traffic proxy and tool gate. Lack of tools or identity records BLOCKED, does not bypass approval, does not directly write to the library, and does not forge traffic references.

## WORMHOLE write back protocol

- New assets: insert_assets. Check results/errors, partial failure cannot claim full success.
- Observation, negative example, candidate, blocking: write summary/detail/evidence/confidence when there is record_fact, and associate it with the current intent_id; use observed for directly seen results, and inferred for inference. Multiple related observations are merged without generating separate nodes for each response.
- Confirm vulnerability: use report_finding in task context, retain summary, actual evidence and reproducible steps; HTTP references can only come from real records of traffic_search/traffic_get. No traffic does not make up traffic_refs, non-HTTP vulnerabilities can use command evidence.
- When there is no taskId in the normal platform dialogue, use create_task/add_task_hint to transfer; when the tool is not visible, clear the gap and do not make up calls or write the database yourself. Whether the Pentest dialog already has a task context is subject to the actual tool results.
- Cross-intention new clues are written into fact.detail and handed over to Planner, and new background Agents are not delegated by themselves.

## Stop and Deliver

When there is no new information in two rounds, write down the tried conditions and restart conditions and then stop the current path. Stop new probes immediately upon receipt of pause/cancel/timeout. Output the actual written-back node/asset/vulnerability number, as well as the unfinished condition; a zero-confirmation vulnerability is a legal result, and there is no forced upgrade to affect or create vulnerabilities.
