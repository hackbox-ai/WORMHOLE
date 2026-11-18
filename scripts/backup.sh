#!/bin/sh
# Run from the project root. Use the same Compose files/project/env as deployment.
set -eu
output="${1:-./backups}/wormhole-$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$output"
docker compose stop wormhole
trap 'docker compose start wormhole >/dev/null' EXIT HUP INT TERM
docker compose exec -T postgres pg_dump -U wormhole -d wormhole -Fc > "$output/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar wormhole -C /var/lib/wormhole -czf - . > "$output/runtime.tar.gz"
docker compose images --format json > "$output/images.json"
printf '%s\n' "$output"
