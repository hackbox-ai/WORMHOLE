# WORMHOLE English edition

The application uses WORMHOLE branding and English interface text, backend messages, tool descriptions, built-in skills, Agent instructions, report templates, and user documentation. The HTML language and date/number formatting use English. Original evidence, user data, third-party licenses, and Unicode recognition patterns retain their original content.

The owner-supplied logo is adapted as transparent native SVG paths, with light and dark wordmarks and compact icons. The entry screen and default workspace use a navy, cyan, and violet black-hole background. See [cosmic background](cosmic-background.md) for asset provenance and the final image prompt.

The technical configuration namespace is `WORMHOLE_*`, the Compose application service is `wormhole`, and browser storage uses `wormhole_*`. Use the current `.env.example` and Compose files for a new installation. Database migration filenames retain their historical identifiers. The Go/WASM template bridge retains its internal ABI.

Migration `0082_wormhole_english_defaults.sql` synchronizes tool reset defaults with the English JSON sources, updates matching untouched tools, and versions untouched first-version built-in prompts. It preserves operator-edited tools and later prompt versions. It does not translate historical conversations, findings, reports, or arbitrary user-authored prompts.

## Verification

- Frontend production build and Docker-oriented static export: passed, 38 generated pages.
- Backend TypeScript check: passed.
- Frontend regression tests: 11 passed.
- Targeted backend regressions: 36 passed, using a disposable PostgreSQL container. Coverage includes Agent editing and rendering, mock-model execution, authentication, username changes, tool resets, fresh installation, report quality, and report job persistence/recovery.
- The report-file symlink test was excluded on Windows because creating the required symbolic link returned EPERM. It still needs a Linux run.
- English source/content scan: 591 files passed (`node scripts/check-english.mjs`).
- Compose configuration checks: core, fingerprint, analysis, and acceptance configurations passed.
- Desktop login, mobile login at 390px, and dashboard screenshots were inspected. The mobile login had no horizontal overflow. Dashboard data was supplied by the existing demo mode; authentication status was stubbed for login screenshots.

The task did not deploy or publish the application, run a real-model security investigation, or perform full Linux/container acceptance. Local verification logs and screenshots are in `artifacts/english-*` and `artifacts/wormhole-*.png`.
