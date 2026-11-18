#!/usr/bin/env bash
set -euo pipefail
fingerprint_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$fingerprint_root/fingerprint-engine"
mkdir -p "$fingerprint_root/vendor/fingerprint"
CGO_ENABLED=0 go build -trimpath -o "$fingerprint_root/vendor/fingerprint/fingerprint-engine" .
