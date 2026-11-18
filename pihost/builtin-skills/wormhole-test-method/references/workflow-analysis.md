# Multi-step process and status analysis

Used for cross-step services such as export, document processing, approval, member collaboration, credential recovery, quota and settlement. The authorization or parameter conclusion of a single endpoint cannot represent the entire process.

## Establish minimum relationship from traffic

Record from a normal and complete process: the subject and its independent identity evidence, object ownership, status before and after operations, parent objects and derived objects, and the issuance and consumption of one-time credentials. The source of the input, how it was transformed, and where it was ultimately used are preserved for each process. Find the normal path first, and then prioritize the boundaries actually involved in this path to check, without generating all checks based on endpoint names.

Focus on checking the relationship between credentials and objects: issuing subject, consuming subject, tenant, purpose, associated object, version, one-time and revocation propagation. After switching tenants, revoking members, and canceling parent objects, verify with existing sessions, re-established sessions, and derived resources respectively. The normal access of the original owner of the revoked object does not mean that another subject can still access it after the revoke.

When the input is used after being stored, queued, templated, jumped, converted, or decoded multiple times, the representation of verification at each stage and the representation of actual consumption are recorded. Use normal input to locate the final product, and then change a stage-related variable; error prompts and parsing success are not effects. Queries, files, URLs, and templates continue to be checked according to their respective specialities, and the severity is not inferred from the length of the processing chain.

## Check constraints with server status

Establish expectations by business agreements or normal processes, rather than assuming on your own: cumulative credit/refunds do not exceed confirmed sources; splitting and merging are conserved; one confirmation credential is only used for its bound object; occupation, release and consumption follow the life cycle; the quotation version corresponds to the current object; the shared quota is effective for all consumption portals. Amounts are in the smallest monetary unit or Decimal, indicating the stage at which rounding occurs.

Pre- and post-read persistent records, ledgers, and re-read results from another authorized test subject. When concurrency is required, first verify the serial behavior, then use the small concurrency allowed by the current task to compare different entries, and finally check the actual number of completions, final balance and resource status. HTTP 200s, echo fields, request numbers, and unusual delays are no substitute for final results.

## Offline auxiliary tools

`scripts/workflow_tools.py`only processes input files, does not connect to the Internet, does not load credentials, does not schedule tasks, and does not register vulnerabilities. Before calling, save the original tool results in the current task artifact, referencing the real traffic/node/artifact number. The output is a navigation or plan to be executed; identity, authorization, evidence validity and current mission status are still verified by WORMHOLE.

```bash
python3 "${SKILL_DIR}/scripts/workflow_tools.py" correlate --input observations.jsonl --output links.json
python3 "${SKILL_DIR}/scripts/workflow_tools.py" matrix --input matrix.json --output plan.json
python3 "${SKILL_DIR}/scripts/workflow_tools.py" compare --baseline before.json --experiment after.json --control absent.json --ignore /server_time
python3 "${SKILL_DIR}/scripts/workflow_tools.py" check --input constraints.json --output checks.json
python3 "${SKILL_DIR}/scripts/workflow_tools.py" candidates --input candidates.json --output guesses.json
```

### observations.jsonl

One observation per row:`evidence_ref`,`subject_ref`,`identity_evidence`,`method`,`url`,`status`,`request`,`response`. request/response is the actual parsed data, do not fill in the guessed value. The tool associates ID, reference, and credential fingerprints; fingerprints only indicate occurrences of the same value, not proof of attribution. Full cookies, authorization and passwords must not be copied to these files.

### matrix.json

Contains`subjects`(id, identity_evidence),`objects`(id, value, owner, ownership_evidence), and`request_evidence`,`request`,`object_pointer`. request is the method/url/body or query object of a normal request, and object_pointer is a JSON Pointer in which fields already exist, such as`/body/resource_id`. No objects need to explicitly set`exists:false`and`absence_evidence`. Use`regenerate`to list the signatures, CSRFs and nonces that need to be recalculated during execution.

The tool lists the normal baseline first, and then lists the non-existent object comparison and cross-subject plan. Sessions are bound by subject_ref by the host; fields not supported by the current tool cannot be shoehorned into parameters. Requests carrying signatures or credentials are first replaced with host references, and real visible tools are used to generate valid requests during replay. Execution plans are still subject to task scope, approval and budget, and written experiments need to be reviewed by the object owner.

### constraints.json

Each item in the`checks`array contains name, kind, values, evidence_refs, and unit can be specified. kind supports`sum_lte`(also limit),`equal`,`unique`,`nondecreasing`,`bound`(also minimum/maximum). Values ​​come from real state snapshots; calculate after clearing the accumulation window, object boundaries, and currency. The result holds:false only indicates that the given value does not satisfy the given constraints and cannot automatically prove the vulnerability or generate a finding.

### candidates.json

`parts`is 2 to 8 groups of observed named variants (up to 40 short strings per group),`joins`is a short separator between adjacent groups, and may be omitted. The tool only performs Cartesian expansion and outputs in the order of input, with an upper limit of 500. It does not have any built-in vocabulary; all materials must come from the visible text of the target itself. Put the most likely variant in the front group. The output is a hypothesis to be verified: according to the target's true throttling rhythm, verified by the authorization tool visible to the host, after success, it is still necessary to actually access the protected resources with that identity.

## Handover

Write back the confirmed relationship, actual effect and negative example with record_fact and associate it with the current intent; candidate retention gap. Cross-step handoffs use the object ID, evidence reference, and next step without copying the full response or credentials. The host checkpoint and exploration graph are used instead of establishing another independent task status library.
