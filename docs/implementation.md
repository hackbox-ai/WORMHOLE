# WORMHOLE first version transformation

## Product Boundary

Business modeling and legacy task, browser, traffic, discovery, evidence, reporting, approval, network, notification and archiving functionality are retained. ScopeSentry, heavy-duty analysis tools, external white-box services, and full PoC/fingerprint data are now optional. The project is only for new installations, there is no environment variables, account aliases or browser storage migration from older products.

## Code entry

-`pihost/src/main.ts`: Service assembly, core initialization and extended status probe.
-`pihost/src/domains/extensions/availability.ts`: Service/data availability, task pinned snapshots, tool and skill assembly.
-`pihost/src/domains/tools/assembly.ts`/`gate.ts`: Filter tools by availability and check again before actual execution; original authorization, scope and approvals continue to be in effect.
-`pihost/src/domains/tasks/engine.ts`/`pihost/src/pi/session-host.ts`: Preserve orchestration and single-session runtime boundaries, and provide knowledge guidance based on actual availability.
-`pihost/src/domains/pocs/`/`fingerprints/`: Cancel the startup of automatic import and support startup when there is no data or engine; existing tasks retain fixed snapshots.
-`pihost/src/domains/skills/seed-builtin.ts`/`pihost/scripts/extensions.ts`: Core Skill initialization and explicit selection, retaining operator editing and authorization revocation.
-`web/src/app/(main)/system/extensions/page.tsx`: Optional capability status and original configuration entry.
-`Dockerfile`/`compose*.yaml`: Core, fingerprint and analysis images, and Linux network capability coverage files.
-`scripts/backup.sh`/`restore.sh`: The database and running files are backed up and restored to an independent empty instance.

## Brand and Resources

The product display name is WORMHOLE and the technical name is wormhole/WORMHOLE. System prompt words, skills, cookies, storage, notifications, reports and download files have been renamed uniformly. The logo retains the user's original image, and transparent native SVG paths provide light and dark wordmarks without an embedded bitmap.

There is a length limit on Linux kernel objects, use gty for network card prefixes, and use WORMHOLE_FWD_GUARD for firewall chains. UNIX sockets in deep working directories are addressed via directory fd to avoid interface failures caused by brand and directory length.

Tip Words The Go/WASM bridge retains its existing internal ABI and build metadata. Compressed checkpoints and artifact frames use WORMHOLE's own naming; no format compatibility with older products is provided.

Complete third-party data, internal delivery archives, and legacy source cross-testing are not released with new projects. Original material is kept as a backup outside the project, and third-party licenses and source acknowledgments remain.
