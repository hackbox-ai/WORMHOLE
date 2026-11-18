# Discovery, path and retest

## View vulnerabilities

The discovery list saves the vulnerabilities and status that have been stored in the database. Open the details to check the scope of impact, reproduction steps, requests and responses, evidence, and verification conclusions. Candidate PoCs, fingerprint hits, and code clues all require further verification.

## Execution path

The overall task diagram shows the overall exploration relationship, and the link diagram of the vulnerability details shows the causal path related to the current discovery.

The vulnerability discovery card is marked in red, and the relevant path connections are marked in red and bold; the card in the middle maintains its original style. The node index can be searched and positioned, click on the node to view details, scroll and pan, and adjust the field of view using the full image or reading scale.

When there are no associated nodes or causal edges found in history, the path cannot be restored out of thin air. You should check the existing evidence and execution records.

## Traffic evidence

Requests and responses can be bound as normal comparison, vulnerability proof or supplementary verification, and instructions and sequences can be set. The evidence is a saved copy; the bound evidence remains after the original traffic is cleaned.

Whether the inspection report needs to be updated after the evidence is changed. Don't rely on a response status code alone to determine impact.

## Retest and continue verification

The retest reads the original evidence and constraints in an independent session, and records the conclusion and evidence. When completed successfully and the fix is ​​confirmed, the vulnerability status changes to Fixed; other results remain in their original status.

Continuing verification will create a high-priority exploration intent in the original task and inherit related asset anchors. Review tasks, scope and additional constraints before execution.

## Reporting and exporting

The task report is based on existing findings and evidence. After completion, check whether the content is complete. Discovery pages can be exported by range and format; the export range is subject to the current selection.
