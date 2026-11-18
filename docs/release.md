# WORMHOLE 0.1.0 Delivery Instructions

This is an independent WORMHOLE project. Business modeling and core functions are retained. ScopeSentry, external white boxes, heavy-duty analysis tools, PoC and fingerprint data are accessed on demand. Old product namespaces, account aliases or historical migration interfaces are not supported.

## File

After running scripts/package-release.py, artifacts/releases/ contains:

- WORMHOLE-0.1.0-source.zip: Complete release of source code, tests, Docker/Compose, documentation, logo and third-party licenses; includes file-by-file MANIFEST.sha256.
- WORMHOLE-0.1.0-linux-amd64.docker.tar: Offline mirror of base applications wormhole:0.1.0 and postgres:16-alpine.
- SHA256SUMS: SHA-256 of the above deliverable.
- release.json: version, file size, hash and actual image ID.

Operational data, test credentials, internal materials, and full third-party PoC/fingerprint data are not in the source package. The base image already contains Chromium and does not include heavy reverse engineering tools.

## Start

Use Docker's Linux container mode and execute it in the decompressed source code root directory. Load the offline image first, and then copy the configuration:

```sh
docker load -i /absolute/path/WORMHOLE-0.1.0-linux-amd64.docker.tar
cp .env.example .env
```

Edit .env to set a separate password for POSTGRES_PASSWORD; WORMHOLE_IMAGE keeps wormhole:0.1.0. Then execute:

```sh
docker compose up -d --no-build --pull never
docker compose ps
```

Openhttp://127.0.0.1:18887/setup/to create an administrator. There is no default administrator password; model providers configure it themselves in the application. PostgreSQL does not publish the port to the host, and the application only listens to the local machine by default.

To build from source code, execute docker compose up -d --build. Optional extensions and network namespace configuration are available in [Extensions Installation](extensions.md) and README.

## Update, backup and acceptance

Execute sh scripts/backup.sh before updating the image; restore using a new empty instance, see [Backup and Restoration] (backup.md). Do not use down -v as a routine stop command.

This time, 123 test files were completed, 537 passed, 0 failed, and 2 real model tests were skipped. The protocol script also passed 51 self-tests and four npm audits showed zero warnings. See [Acceptance Record](validation.md) for the complete scope and boundaries.

The original code of the project now uses [AGPL-3.0-only](../LICENSE), and third-party licenses continue to be retained separately. The delivery and acceptance data on this page records the status of the first version when it is delivered. For subsequent changes, see [Update Record](update-2026-11-16.md).
