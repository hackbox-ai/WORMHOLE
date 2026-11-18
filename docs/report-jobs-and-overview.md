# Overview of vulnerability reporting jobs and tasks

## Storage and generation

0081 Create a persistent report job for the new discovery into the database, and submit it in the same transaction as the discovery. Press finding_id + evidence_version to remove duplicates; it does not occupy test task slots and does not rely on universal triggers that can be turned off. The old reporter/report_finding trigger is deactivated to avoid duplicate jobs, other user triggers remain unchanged. Migration only identifies the status of historical reports and does not overwrite batches or automatically rerun historical discovery.

A maximum of two copies of the fixed queue can be reported in parallel, using the model, budget and text style configuration of the existing reporter. The host is limited to only five tools: reader discovery context, source intent record, bound traffic, files within tasks, and draft submission; customToolsOnly prohibits reinstallation of Bash, HTTP, MCP, custom tools, and task dispatch. Targets will not be retested due to compilation reports.

Job has lease, restart recovery, three bounded retries, and backoff. The normal stop of the service does not consume the number of error retries; the user's cancellation of the report session does not automatically restart. Pausing/stopping testing and canceling report compilation are independent operations.

## Text and evidence

Report Agent obtains the key execution record index and search terms, gives priority to directional reading of core operations and comparisons, and does not fully traverse irrelevant records. Records support search, paging, segmented reading, and set a reading budget; the page displays recent reading progress. Lack of traffic does not prohibit writing reports based on commands, logs, and files.

The host inspection chapter has actual text, a complete quality statement, references to sources that are actually read this time, and there are no ellipsis placeholders for key certification steps. When there is already a source execution record/binding traffic, the official report requires actual reading of the reference. If it cannot be obtained, the certificate will be pending. There is no word count threshold, and common restrictions such as unreviewed source code, uncovered additional variants, and unbound HTTP traffic will not automatically prevent completion. Only gaps that affect core reproduction/actual consequences will be added to the certificate. Structural and provenance checks are not a substitute for factual auditing; models must differentiate between verified impacts, inferences, and unknown scope.

Publish only if the session ends normally and the draft passes the check. Evidence version changes will eliminate old jobs; releases also compare initial report hashes to prevent overwriting manual modifications. The replaced text is saved to the version table. The draft certificate to be supplemented does not cover the existing official text, and the UI displays the gap alone.

## Interaction and History

The discovery details are displayed first in the report, distinguishing between pending improvement, waiting to be generated, generating, pending certification, completed, failed and canceled. You can generate/retry/cancel a single item and view the generation process and old text. The task overview displays the number of completed reports and those to be completed, and provides a confirmation entry for "Complete Reports"; the batch interface has a maximum of 20 entries per batch, retains completed reports, and repeats requests idempotently.

Interface: GET /api/exploration/findings/:id/report; POST same path as /retry, /cancel; GET /versions/:version; POST /api/finding-reports/backfill supports dry_run.

## Overview

The directory sequence is task overview, execution path, task dialogue, task browser, business modeling and other original columns. The task list enters the default overview, and the explicit tab=sessions entry is retained.

The overview is summary, current execution and latest findings, goals and progress, task description, scope and constraints, coverage, model usage, and asset rules. The completed task compresses the current execution into one row and uses double columns to avoid large blank spaces. Target/scope/constraint editing, intent rerun, and asset rules are all retained; adding forms, long descriptions, and model details are expanded with clear buttons.

## Verify

finding-report-jobs.test.ts validates atomic warehousing, trigger shutdown, task suspension, quality rejection, evidence versioning, human editing, backoff/recovery, cancellation, history backfill, path protection, and HTTP authentication. finding-report-native.test.ts Verifies that tool whitelisting, read and commit, host publishing, and test tasks are not evoked via a real Pi session with the controlled model protocol. Also performs legacy discovery, notifications and session regression, browser validation of overview directories, forms, report generation/cancellation/completion/version and mobile layouts. Real model acceptance uses existing evidence from isolated replicates without access to the target drone.



This task report will stop sorting before archiving; new sorting requests will not be accepted during archiving/restoration. Restoring the transaction retains the report status and prohibits triggering the generation of historical reports. If the old archive lacks new fields, the default value will be filled; the text version of the historical report is retained with the archive.
