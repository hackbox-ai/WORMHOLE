#!/bin/sh
# Restore into a new empty Compose project, never overwrite an existing instance.
set -eu
input="${1:?Usage: sh scripts/restore.sh /path/to/backup}"
test -s "$input/database.dump"
test -s "$input/runtime.tar.gz"
docker compose up -d --wait postgres
count=$(docker compose exec -T postgres psql -U wormhole -d wormhole -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
if [ "$count" != 0 ]; then echo 'Restore requires an empty database in a new Compose project.' >&2; exit 1; fi
# Refuse a populated runtime volume as well.
docker compose run --rm --no-deps -T --entrypoint sh wormhole -c 'test -z "$(ls -A /var/lib/wormhole 2>/dev/null)"'
docker compose exec -T postgres pg_restore -U wormhole -d wormhole --no-owner --exit-on-error < "$input/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar wormhole -C /var/lib/wormhole -xzf - < "$input/runtime.tar.gz"
docker compose up -d --wait wormhole
