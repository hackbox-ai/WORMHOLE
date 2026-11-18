# WORMHOLE 0.1.0 Acceptance Record

Date: 2026-11-14 (Asia/Shanghai). Acceptance environment: Docker Desktop Linux x86_64, Docker Engine 29.9.2, Node.js 22.23.2, PostgreSQL 16.15. The backend uses Pi 1.5.2 and the frontend uses Next.js 16.4.6.

## Conclusion

The core platform, Docker deployment, business modeling and default optional analysis tool chain within the scope of this delivery have been accepted. The final result for 123 TypeScript test files was 537 passes, 0 failures, and 2 skips. Both skips were tests that required real model vendor credentials and were not counted as passes.

See [acceptance-results.json](acceptance-results.json) for file-by-file results, test source code hashes, and raw log hashes. After repair, the failed items and affected processes were retested; this file records the final results. The initial failed run is not counted as an acceptance pass.

## Scope and Evidence

| Scope | Verification Content | Primary Test Documents or Inspections |
| --- | --- | --- |
| New project and brand | WORMHOLE name, system prompt words, environment configuration, cookies, notifications, download packages, provided Logo; no old product naming compatible entry | extensions, auth-username, notification-branding; source code scanning and page screenshots |
| Docker and initialization | Empty database migration, first account, custom user name, login and credential persistence, health check, container update | fresh-install, auth-settings; independent Compose project test |
| Agent Execution | Real Pi SDK session and tool executor, model pooling and switching, budget, stop/pause, concurrency slots, retry, session resume and model original recording | vertical-real, approval-native-matrix, llm-*, run-budget-native, task-*, process-recovery |
| Business modeling | Draft, submission and completion, version, entry verification, parallel modeling, continuous execution of main tasks, timeout draft retention | modeling 26 items, modeling-parallel 5 items, modeling-validation 1 item |
| Assets and Evidence | Company and Scope, Asset Association and Deduplication, Discovery Verification, Roadmaps, Reports, Traffic Evidence, Archiving and Cleanup | assets, finding-*, exploration-*, traffic-*, storage-*, task-archives |
| Approval and cancellation | Allow/deny, manual approval, timeout processing, parameter changes after approval, blocking side effects when stopping | approval-*, intercept-*, tool-gate*, vertical-approval |
| Deadline closing | Expiration blocks new requests and commands; controlled preservation of existing facts; final goal proof; explicit stop is not overridden by closing | deadline-native, deadline-coordinator, task-report-finalization |
| PoC and fingerprints | Basic deployment without built-in complete data, explicit import, rule identification, fixed snapshot, snapshot boundary of existing tasks after the data source is closed | poc-*, fingerprints, fingerprint-orchestration, fresh-install |
| Network and Browser | Real Linux connector, two hops, range isolation, DNS and cache expiration, TCP/UDP/ICMP/IPv6/SYN, disconnect recovery, real Chromium workspace | network-*, browser-workspace; network-full 15 items passed |
| Skills and Extensions | Missing capability filtering, pre-execution review, explicit installation, retained user editing, authorization, MCP actual connection and resource recycling | extensions, methodology-*, mcp-*, reverse-analysis |
| ScopeSentry client | Actual MCP HTTP handshake and authentication, tool discovery, paging, company and asset writing, deduplication, error propagation and no more requests after disabling | scopesentry-contract 6 items; controlled compatibility services |
| External white box client | Authentication, import/query/audit contract, cancellation, configuration key not echoed, actual MITM download | reverse-analysis; controlled compatibility service |
| REA/Ghidra/JS | Actual compilation of ELF, Ghidra decompilation of arithmetic functions, JS source code restoration and formatting, Linux PTY, Skill unlocking and resource recycling; actual operation in the springboard | reverse-runtime, reverse-analysis, network-full; no analysis branch skipping |
| Android | Compile native JAR, load, class, and decompile via JADX MCP; Apktool builds and decodes native APK | android-runtime 3 passes |
| Protocol tools | Actual installation of dpkt/construct, protocol script self-test; execution in isolated workspace | Python self-test passed 51 times; network-full |
| Backup and recovery | Consistent backup after stopping the application, restore to another set of empty database and running volume; log in with the original account and verify the running file | scripts/backup.sh, restore.sh are actually executed; after recovery, the application is healthy and the version is correct |
| Front-end | Next.js static construction, initialization of light and dark colors/mobile phone size, logo, extension page and business modeling entrance; no browser script errors | release-ui page inspection and screenshots |

Backend type check, frontend production build, network component Go test, Linux/Windows connector build all passed. Notification template's Linux/Windows Go executor has been rebuilt from the current WORMHOLE module, with updated hashes.

## Dependency check

Four npm audits all showed zero warnings, recorded in [dependency-audits](dependency-audits/): backend, frontend, REA default installation configuration (excluding optional Frida), JavaScript toolkit. This conclusion is based on the npm announcement check of the corresponding lock file and does not represent the conclusion of the operating system package, all external services, or the complete product security audit.

Pi's upgraded transcript context, tool/prompt word statistics, round completion hook, cancellation and ending have been adapted and returned. The full test did not directly overwrite the SDK private loop state.

## Explicit validation boundaries

- Model-driven integration tests use local deterministic providers with real execution of real tools, side effects, databases, and recovery processes; no real model API credentials are provided. Two items, glm-e2e and real-model-recording, are skipped and do not claim to verify the effect, cost or performance of the real model.
- The client contract between ScopeSentry and the white-box service has passed controlled service verification; the warehouse does not contain these independent services, and the user's actual deployed service version and credentials have not been verified.
- The default component of the analysis extension rea/js/native/android/protocol has been installed and tested. Frida is retained as a separate option and does not perform dynamic instrumentation acceptance of the real process.
- Windows connector and template executor complete cross-build; no transition in real Windows to complete connector end-to-end acceptance. The certified platform for delivery server images is Linux x86_64.
- The project-level open source license is not currently selected according to the maintainer's requirements. This time it is not published to the remote warehouse or mirror warehouse.

## Delivery and re-inspection

[Delivery Instructions] (release.md) includes source code package, offline image, checksum and startup method. The basic isolation test uses the root directory compose.acceptance.yaml; the complete analysis test uses Docker's test-analysis target. For details, see [Test Instructions](../pihost/docs/reference-tests.md).

Raw logs, screenshots, and test backups are located in local artifacts/validation/; the test configurations and backups may contain credentials that have been excluded from the source package and Docker build context. The public results file only keeps counts, test names, and hashes.
