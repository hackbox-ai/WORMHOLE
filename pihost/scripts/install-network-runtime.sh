#!/bin/sh
# Pin the upstream module and verify it through Go's module checksum mechanism.
set -eu
FRP_VERSION=0.72.0
WORMHOLE_FRP_DIR="${WORMHOLE_FRP_DIR:-/opt/wormhole/network/frp-$FRP_VERSION}"
mkdir -p "$WORMHOLE_FRP_DIR"
CGO_ENABLED=0 GOBIN="$WORMHOLE_FRP_DIR" go install -p 2 -tags noweb "github.com/fatedier/frp/cmd/frps@v$FRP_VERSION" "github.com/fatedier/frp/cmd/frpc@v$FRP_VERSION"
MODULE="$(go env GOMODCACHE)/github.com/fatedier/frp@v$FRP_VERSION"
cp "$MODULE/LICENSE" "$WORMHOLE_FRP_DIR/LICENSE"
if [ "${WORMHOLE_BUILD_WINDOWS_CONNECTOR:-1}" = 1 ]; then
 (cd "$MODULE" && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -p 2 -tags noweb -trimpath -ldflags="-s -w" -o "$WORMHOLE_FRP_DIR/frpc.exe" ./cmd/frpc)
fi
"$WORMHOLE_FRP_DIR/frps" --version

RUNTIME="$(CDPATH= cd -- "$(dirname -- "$0")/../network-runtime" && pwd)"
(cd "$RUNTIME" && CGO_ENABLED=0 go build -trimpath -o "$WORMHOLE_FRP_DIR/wormhole-connector" .)
if [ "${WORMHOLE_BUILD_WINDOWS_CONNECTOR:-1}" = 1 ]; then
 (cd "$RUNTIME" && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -o "$WORMHOLE_FRP_DIR/wormhole-connector.exe" .)
 TMP="$(mktemp)"
 trap 'rm -f "$TMP"' EXIT
 curl -fL --connect-timeout 15 --max-time 120 https://www.wintun.net/builds/wintun-0.14.1.zip -o "$TMP"
 echo "07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51  $TMP" | sha256sum -c -
 python3 - "$TMP" "$WORMHOLE_FRP_DIR" <<'PY'
import zipfile,pathlib,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 root=pathlib.Path(sys.argv[2])
 (root/'wintun.dll').write_bytes(z.read('wintun/bin/amd64/wintun.dll'))
 (root/'WINTUN-LICENSE.txt').write_bytes(z.read('wintun/LICENSE.txt'))
PY
fi

(cd "$RUNTIME" && python3 - "$WORMHOLE_FRP_DIR/THIRD-PARTY-NOTICES.txt" <<'PY'
import subprocess,pathlib,sys
parts=[]
for module in ['golang.zx2c4.com/wireguard','golang.zx2c4.com/wintun','golang.org/x/sys','golang.org/x/net']:
 directory=subprocess.check_output(['go','list','-m','-f','{{.Dir}}',module],text=True).strip()
 file=pathlib.Path(directory)/'LICENSE'
 parts.append(module+'\n\n'+file.read_text())
pathlib.Path(sys.argv[1]).write_text('\n\n'.join(parts))
PY
)
