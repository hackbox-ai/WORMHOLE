# Task resources and manual cleanup

Entry: Workspace → Task Product. Sort by the amount of task-related data; "Details" lists sources and paths, "Clean" selects categories and previews, and then executes them explicitly. There is no automatic task cleaning switch.

## Data caliber

- Task related data: task file, request response, model recording body, native session, streaming incremental and cold archive, tool result object, registered browser temporary directory. Exclusive modeling subtasks are classified into parent tasks, while shared modeling only displays and retains associations.
- File occupancy: use file system allocated blocks; content-addressed objects are deduplicated by path. The total files, indexes and unowned files of the shared database are listed separately and are not converted into task exclusive space.
- Database reusability: Estimate of content size that can be reused by the database after cleaning the text, no commitment to immediate database file reduction. VACUUM FULL will not be performed on the request.
- File release: Only files allocated blocks that are actually successfully unlinked are counted; the difference in available space in the file system before and after cleaning is also returned, which may be affected by other writes in the same period.

## Ownership and Protection

WorkspaceMaintenance continues to provide file reference protection and task run mutex. TaskResources summarizes various storage sources, matches events through precise taskEventScope, and does not delete by domain name or task number substring. Traffic is attributed via context.taskId; shared blobs and tool results must have no other references before they can be removed. Keep findings, reports, upload attachments, evidence, and call usage. Tasks in running, paused, queue, active browser, and retest cannot be cleaned.

Native sessions and browser-created directories are written to task_resource_paths; historical native sessions are restored based on the recorded business_kind/business_id. Bash's default temporary and cache directories are set in the current task working directory .runtime, and springboard isolation mode maintains the same path for mounting. Programs and historical unregistered directories that actively specify external paths cannot be reliably traced back to a task and are not automatically attributed or deleted; the unattributed parts of the data directory are displayed in separate columns.

## Clean execution

/api/workspace/resources summary, resource-detail to view details, resource-preview to generate a ten-minute preview, resource-cleanup to execute explicitly, resource-history to view persistence results. The original cleanup interface of the file browser is retained.

Preview saves bounded lists and fingerprints, and re-verifies files, references and task status before execution. Cold archives use advisory locks in the same lifecycle order as tool objects; reference changes are committed first, and non-referenced files are removed. Events preserve sequence numbers and UIDs, streaming incremental writes have explicit cleanup markers, and final messages and semantic events are preserved. Model recording retains metadata and statistics, and the detailed text has been manually cleaned.

There is not a single transaction across PostgreSQL, SQLite and file systems. The task cleanup records are dropped into the database first, and the files to be deleted are persisted; the remaining files will continue to be visible after failure/restart, and you can preview again and try again. The execution results include failed items. No large list of completed records is retained, and expired previews are automatically recycled to avoid cleaning metadata from expanding.

## Verify

task-resources.test.ts covers multi-storage cleanup, independent evidence protection, shared traffic and tool objects, running mutex, preview changes, cold archive pointers, exclusive/shared modeling, restart recovery, symbolic links, task cache paths and single connection pools. workspace-cleanup.test.ts retains the original file interface and returns HTTP authentication. In addition, regression related to storage, model recording, browser workspace and session mapping is performed, as well as complete interactive verification of the isolated browser from detail to cleanup history.


When aggregating events, the entire database is aggregated by business identity, and then attributed according to precise task boundaries; file scanning can be up to four concurrent, and repeated reference checks match the cache literally, without changing the evidence protection semantics.
