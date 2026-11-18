# Dashboard and Token measurement

Dashboard only reads the sequential call ledger llm_usage; it does not superimpose activity and conversation_activities to avoid repeated calculation of the same task conversation. Original activity and historical import data remain in place.

## Caliber

- Total = Uncached Input + Cached Reads + Cached Writes + Outputs.
- Total input includes three types of input; cache hit rate is cache reads / total input.
- Calculated based on actual call time based on Asia/Shanghai natural days. 7 days includes today and the previous 6 days; 0 means the entire ledger.
- Metering overview, configuration grouping, source grouping, daily trends share the same read-only REPEATABLE READ snapshot and filter.
- Errors, interrupts, and retried calls are counted as recorded usage; usage that is not returned cannot be extrapolated. This view does not promise to match supplier billing.
- Configuration attribution uses actual profile_id; retains historical name or single column "unattributed configuration" when ID is missing, does not guess today's default configuration.
- When a conversation is associated with a task, it is called attribution as a task, but each ledger line is only counted once.
- Business modeling single column source; the number of associated execution tasks includes business modeling and deleted historical tasks, and is not equal to the number of visible tasks in the task list.
- Complement the dates that are not called in the selected range; use bigint for aggregation to avoid the cumulative value exceeding int32.
- Historically missing configurations/task ownership cannot be completely reconstructed with the current default configuration.

## Interface and entrance

src/domains/observability/token-meter.ts provides unified query. GET /api/tokens/usage and /api/tokens/usage/calls share the days, profile, source, and task parameters. Details also support page and page_size, with a maximum of 100 items per page. The request/response body or API credentials are not returned.

The frontends are web/src/app/(main)/dashboard/ and web/src/components/dashboard/token-panel.tsx. Tasks, risks, and asset overviews use independent data sources; model usage has independent filtering and refreshing, and the failure of a certain interface will not stop the entire page from being updated.

## Verify

    npm run typecheck
    WORMHOLE_CONFIG=<test-config> node --import tsx --test tests/token-meter.test.ts tests/dashboard-token-usage.test.ts

Isolated testing covers coverage across midnight, empty dates, configuration renames, default configuration switches, unowned records, different configurations for the same model, business modeling/task conversations, cumulative values ​​over 32 bits, paged reconciliation, and single-response snapshot consistency during concurrent inserts.

Before deployment, it is necessary to directly check the sum with the runtime library, and verify the desktop/tablet/mobile phone, dark and light themes, date/configuration/source/task filtering, detailed paging and empty data.
