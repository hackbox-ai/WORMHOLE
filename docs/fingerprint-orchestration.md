# Fingerprint participation in task arrangement

This increment is connected to the official multi-worker test task on the development machine and does not overwrite the Agent prompt words saved by the user; the operation guidance is added by the host. The six database rules in the configuration are still fixed as task snapshots, and fingerprints provide product assumptions and evidence navigation, and do not automatically confirm vulnerabilities.

## Execution sequence and budget

```mermaid
flowchart TD
  A[Target and constraint disassembly/Original modeling dependencies] --> B[Fixed rule snapshot]
  B --> C[budgeted entry GET]
  C --> D [Asynchronous six database identification]
  D --> E[First round of Planner results and gaps]
  E --> F [Intention with fingerprint reference and stop condition]
  F --> G[Worker receives the relevant asset basis and actually verifies it]
  G --> H[New response identification / related update push]
  H --> E
  E --> I[Queue and review closing fence]
  I --> J[Complete or leave clear gap]
```

The entry source is limited to the HTTP/HTTPS URL explicitly given by the user, the declared modeling entry, and the registered Web services within the task scope; no subdomain guessing, no port enumeration, and no automatic icon capture. Maximum of 3 entries, total budget of 20 seconds, maximum of 8 seconds for a single request, and maximum waiting time of 6 seconds for identification within the remaining budget. Executed through the existing http_request tool, complying with start and stop, tool binding, interception, approval and pre-execution cancellation checks. Explicit passive/offline requirements, forbidden targets, and policy rejections are marked as gaps. When there is no web portal or identification is unavailable, normal tasks continue.

Entry status is persisted to fingerprint_task_entries; completed entries will not be collected repeatedly due to restarts. Start-up over-budgets, failures, and lack of materials are recorded separately from hits. The first phase is executed after the original pre-modeling dependencies are satisfied and before the Planner/Worker loop.

## Information distribution and actual adoption

Planner obtains a task-level streamlined summary, with a maximum of 24 groups and 16 KB; Worker has a maximum of 12 groups and 8 KB. The number of omissions is clearly recorded, and the original basis can still be queried on demand to avoid supplementary information crowding out task constraints and actual test evidence. Workers filter based on the asset_ids of the current intention, clear URL, fingerprint_observation_ids and the materials they have collected; filter first and then take the upper limit of the quantity, without replacing the relevance with the full task summary. If there is no associated object, the tool will query it explicitly and no identification of other assets will be injected. get_asset_fingerprints supports reading by asset/URL; Worker calls without parameters default to the current intent scope.

Product or version changes update the task revision number and notify the Planner. The relevant executing Worker receives updates via native session.steer and consumes them in subsequent model calls; the current action will not be automatically canceled due to fingerprint updates. The HTTP tool receipt returns both pending/ready and query entry.

add_intent can carry up to 20 fingerprint_observation_ids. The host verifies that these references belong to the current task, falls into the intent payload, and records fingerprint_intent_linked. Observation IDs do not belong to the exploration graph fact namespace and cannot be used for prove_goal or to pretend to be new facts.

The three states are accounted for separately:

- fingerprint_context_delivered: Digest loaded into Planner/Worker context or related update queue; not equal to model adoption.
- fingerprint_context_reviewed: The planning model round carrying this revision ended successfully; request failure or cancellation does not advance the reviewed revision.
- fingerprint_intent_linked, native tool calls and subsequent facts: used to prove that the fingerprint has indeed entered the specific test direction and execution. Actual acceptance must also check this layer of evidence.

Fingerprint references do not increase test completion. The existing deduplication and stopping conditions still constrain new intentions, and the attack list cannot be automatically distributed for each product.

## Closing, cancellation and recovery

The three common closing paths of coverage completion, goal-by-goal proof, and old goal_met entire task completion all check the queue and unreviewed revisions, and wait up to 15 seconds. The entire task completion request is retained when it is delayed by the fence, and continues to be closed after successful review and queue processing. Unprocessed materials and unreviewed revisions are recorded over time, ending with a gap is allowed, and false reporting of identification completion is not allowed. Priority is still given to the absolute deadline of the task, and the final summary includes fingerprint gaps; explicit human continuation resets the ending fence, and retains rules and evidence.

Pause, End, and Delete prohibit late result publication. The process is closed to return the matching in progress to pending, and then the offline assistant is closed; restarting can continue based on persistent materials to avoid background sub-processes being re-started or results being lost. Task archives include collection entries, delivery records, fixed snapshots, queues, and observations; restore fingerprint archives before compatibility with 0064.

The asset "fingerprint basis" shows the entry collection stage, current revisions, reviewed revisions and closing gaps. The configuration page describes the budgeted automatic entry stage.

## Validation and Boundaries

Special verification uses real Nginx binary responses and Node negative services without product tags; does not forge Server headers in negative responses. The fixed model fixture is used to verify the real Pi native loop and push/query/task state machine, and the existing GLM model configuration is used for real model measurement. The two types of results are retained separately, and the fixed fixture cannot be passed as a real model.

The test database is independent, and the code test creates an independent schema in it; the orchestration integration test is skipped when WORMHOLE_FINGERPRINT_TEST_DSN is not set. The real model script tests/fingerprint-live.ts requires explicit WORMHOLE_FINGERPRINT_LIVE=1 and refuses to connect to the normal run database; will read the configured model credentials and only perform up to 12 GETs for the two controlled loopback services. The key does not go into the source code or reports.

At this stage, automatic entry and execution push are oriented to formal multi-Worker tasks. Standalone pentest conversations still obtain information through HTTP receipts, fingerprint query tools, and task results, and have not yet reused the startup phase of multiple workers. Global proxy/external shell/browser traffic will continue to not be automatically mixed in when there is no reliable task attribution.

Development machine working directory: /root/wormhole-fingerprint-orchestration-20261020/. Real model evidence real-model-result.json, fixed loops and regression test logs are stored separately. The first real model attempt was interrupted due to insufficient total waiting window for the acceptance script, and is retained as real-model-first-interrupted.json, regardless of success; the final result is subject to complete evidence inspection.

For a complete real model case, see [Real Model Acceptance](fingerprint-live-validation.md).


## Conclusion of this verification

In the end, 10 orchestration projects, 14 existing fingerprint projects, 34 tasks/assets/archives, etc. regressions, and 26 modeling regressions passed. Includes receiving relevant fingerprint updates in real Pi native requests, byte budget not deleting original basis, delay recognition prohibiting early completion, old completion request retention, shutdown and restart recovery, passive constraints and archive consistency. Front-end and back-end type checks, new front-end Biome checks and static builds passed.

The real model acceptance library has read-only tool switches and real model configuration, and cannot be reused as a general regression library. The first mixing resulted in four general regression items being contaminated by the configuration; the general regression was rerun in the independent empty library config.regression.json, and 34 items passed; the modeling was rerun in the independent modeling_test_fp_final_20261020, and 26 items passed. Relevant original logs are retained, and runs with configuration pollution are not counted as passed.
