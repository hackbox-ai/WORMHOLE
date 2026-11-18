# Test configuration

WORMHOLE uses its own source code and isolated database to verify behavior and does not rely on frozen source code of older products. The original internal source control fixture is not released with the new project.

The base test uses`WORMHOLE_CONFIG`to point to the test configuration, where the database, dataDir, and pi.agentDir must be independent of the running instance.

-`npm run typecheck`: Backend type checking.
-`npm test`: Current test suite; requires corresponding test library and tool dependencies.
-`npm run test:acceptance`: Use`WORMHOLE_ACCEPT_ADMIN_DSN`to specify a standalone PostgreSQL instance to create and delete temporary test libraries on a file-by-file basis. Must not point to a working instance; the test environment account requires CREATE DATABASE permissions. It is recommended to use the isolation database in the root directory`compose.acceptance.yaml`.
-`WORMHOLE_MODELING_TEST_DSN`: Business modeling integration test, the library name must start with modeling_test.
-`WORMHOLE_POC_TEST_DSN`: PoC, batch tasks and associated scenarios, the library name must start with wormhole_poc_test.
-`WORMHOLE_FINGERPRINT_TEST_DSN`: Fingerprint integration and orchestration testing requires a matching engine.
-`WORMHOLE_FRESH_TEST_DSN`: Fresh initialization and uninstalled extension test, no fingerprint engine installed.

Integration testing of model processes uses local mock providers and local targets and does not require real model credentials. Tests that require additional environments should be configured according to their requirements, and skipping tests cannot be regarded as verified.

The analysis toolchain can be accepted through Docker's`test-analysis`build target and set up`WORMHOLE_REVERSE_INTEGRATION=1`; the base`test`target does not install heavy tools such as Ghidra/JADX, but does include the fingerprint engine required for controlled testing. Engineless initialization tests specify missing paths individually.

`WORMHOLE_ACCEPT_OUTPUT`specifies the log and results.json output directory, and`WORMHOLE_ACCEPT_TIMEOUT_MS`sets the timeout for each file. You can pass the test file name (excluding`.test.ts`) at the end of the command to run only the specified package.`WORMHOLE_ACCEPT_RESUME=1`will retain the last passing result and rerun the failed files; after changing the code or dependencies, you should clearly select the package that needs to be re-verified.
