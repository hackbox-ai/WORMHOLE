#!/bin/sh
set -eu
cd "$(dirname "$0")"
GATYUSHA_TEMPLATE_GO="${GATYUSHA_TEMPLATE_GO:-go}"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 "$GATYUSHA_TEMPLATE_GO" build -trimpath -buildvcs=false -ldflags='-s -w' -o codec-linux-amd64 .
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 "$GATYUSHA_TEMPLATE_GO" build -trimpath -buildvcs=false -ldflags='-s -w' -o codec-windows-amd64.exe .
chmod 755 codec-linux-amd64
sha256sum codec-linux-amd64 codec-windows-amd64.exe > codec.sha256
"$GATYUSHA_TEMPLATE_GO" version > compiler.txt
