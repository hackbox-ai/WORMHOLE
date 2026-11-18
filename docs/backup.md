# Backup and recovery

The database and running files together form a persistent state and must be backed up within the same stop window.

Execute`sh scripts/backup.sh ./backups`in the project root directory. The script briefly stops the application, backs up the PostgreSQL and runtime volumes, and finally starts the application. When using multiple Compose overlay files, specify the same files as the actual deployment via COMPOSE_FILE (colon separated); COMPOSE_PROJECT_NAME, environment file, and image selection should also be consistent.

Restore for a new empty instance: Prepare the same version of source code and image, set the target database password for`.env`, and use an independent Compose project name and port. Execution:

```sh
export COMPOSE_PROJECT_NAME=wormhole-restore
export WORMHOLE_PORT=18888
sh scripts/restore.sh /absolute/path/to/backup
```

The script refuses to restore to a target that already has a business table or a run file. After recovery, check logins, tasks, model configurations, evidence files, and key pages. The generated run configuration is rebuilt according to the target environment; models, login signing keys, sessions, and other run files are preserved. External services and tool chains are not included in the backup and need to be re-provided with reachable addresses and tool images.

The backup file contains credentials, evidence and session content, and is managed by instance data. Back up before the official update, and use a complete backup for rollback after data migration.
