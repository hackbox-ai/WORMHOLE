ARG NODE_IMAGE=node:22.23.2-bookworm-slim
FROM ${NODE_IMAGE} AS backend-deps
WORKDIR /opt/wormhole/pihost
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN if command -v node >/dev/null; then node -e "require('fs').writeFileSync('/tmp/build-ca.pem',require('tls').rootCertificates.join('\n'))"; else cp /etc/ssl/certs/ca-certificates.crt /tmp/build-ca.pem; fi \
 && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pihost/package.json pihost/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund --fetch-retries=1 --fetch-timeout=120000
FROM backend-deps AS backend-check
COPY pihost/ ./
COPY extensions/ /opt/wormhole/extensions/
RUN npm run typecheck

FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /build/web
ENV NEXT_TELEMETRY_DISABLED=1 HUSKY=0
COPY web/package.json web/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund --fetch-retries=1 --fetch-timeout=120000
COPY web/ ./
COPY docs/user-guide/ /build/docs/user-guide/
RUN npm run build:static

FROM golang:1.26-bookworm AS network-build
WORKDIR /build/pihost
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN if command -v node >/dev/null; then node -e "require('fs').writeFileSync('/tmp/build-ca.pem',require('tls').rootCertificates.join('\n'))"; else cp /etc/ssl/certs/ca-certificates.crt /tmp/build-ca.pem; fi \
 && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem install -y --no-install-recommends curl python3 unzip && rm -rf /var/lib/apt/lists/*
COPY pihost/network-runtime/ ./network-runtime/
COPY pihost/scripts/install-network-runtime.sh ./scripts/install-network-runtime.sh
ENV WORMHOLE_FRP_DIR=/opt/wormhole/network WORMHOLE_BUILD_WINDOWS_CONNECTOR=1
ARG GOPROXY=https://proxy.golang.org,direct
RUN GOPROXY="$GOPROXY" sh scripts/install-network-runtime.sh

FROM golang:1.26-bookworm AS fingerprint-build
WORKDIR /build/fingerprint-engine
ARG GOPROXY=https://proxy.golang.org,direct
COPY pihost/fingerprint-engine/ ./
RUN CGO_ENABLED=0 GOPROXY="$GOPROXY" go build -trimpath -o /fingerprint-engine .

FROM ${NODE_IMAGE} AS runtime-base
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN if command -v node >/dev/null; then node -e "require('fs').writeFileSync('/tmp/build-ca.pem',require('tls').rootCertificates.join('\n'))"; else cp /etc/ssl/certs/ca-certificates.crt /tmp/build-ca.pem; fi \
 && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem install -y --no-install-recommends ca-certificates openssl python3 python3-venv curl git tini iproute2 iputils-ping dnsutils netcat-openbsd socat util-linux file unzip zip && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/wormhole/pihost
COPY --from=backend-check /opt/wormhole/pihost/node_modules/ ./node_modules/
COPY pihost/package.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/wormhole/browsers
ARG PLAYWRIGHT_DOWNLOAD_HOST
RUN PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST" node node_modules/playwright-core/cli.js install --with-deps chromium
RUN apt-get -o Acquire::Retries=2 update && apt-get install -y --no-install-recommends nmap && rm -rf /var/lib/apt/lists/*
COPY --from=backend-check /opt/wormhole/pihost/src/ ./src/
COPY pihost/migrations/ ./migrations/
COPY pihost/builtin-skills/ ./builtin-skills/
COPY pihost/vendor/ ./vendor/
COPY pihost/scripts/ ./scripts/
COPY pihost/runtime/ ./runtime/
COPY extensions/ /opt/wormhole/extensions/
COPY docker/ /opt/wormhole/docker/
COPY LICENSE /opt/wormhole/LICENSE
COPY THIRD_PARTY_NOTICES.md /opt/wormhole/THIRD_PARTY_NOTICES.md
COPY --from=network-build /opt/wormhole/network/ /opt/wormhole/network/
ENV NODE_ENV=production WORMHOLE_WEB_DIST=/opt/wormhole/web WORMHOLE_FRP_DIR=/opt/wormhole/network WORMHOLE_TOOLS_DIR=/opt/wormhole/tools
EXPOSE 18887
ENTRYPOINT ["/usr/bin/tini","--","node","/opt/wormhole/docker/entrypoint.mjs"]
CMD ["node","--import","tsx","src/main.ts"]

FROM runtime-base AS test
RUN apt-get -o Acquire::Retries=2 update && apt-get install -y --no-install-recommends iptables gcc g++ make procps && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=test
ENV WORMHOLE_FINGERPRINT_ENGINE=/opt/wormhole/test-tools/fingerprint-engine
COPY --from=fingerprint-build /fingerprint-engine /opt/wormhole/test-tools/fingerprint-engine
COPY --from=network-build /usr/local/go/ /usr/local/go/
COPY pihost/tests/ ./tests/
COPY web/src/ /opt/wormhole/web/src/
COPY pihost/tsconfig.json ./

FROM runtime-base AS core
COPY --from=frontend-build /build/web/out/ /opt/wormhole/web/

FROM core AS analysis
USER root
ARG DEBIAN_MIRROR=https://deb.debian.org
RUN if command -v node >/dev/null; then node -e "require('fs').writeFileSync('/tmp/build-ca.pem',require('tls').rootCertificates.join('\n'))"; else cp /etc/ssl/certs/ca-certificates.crt /tmp/build-ca.pem; fi \
 && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update && apt-get -o Acquire::https::CaInfo=/tmp/build-ca.pem install -y --no-install-recommends gcc g++ make python3-dev procps && rm -rf /var/lib/apt/lists/*
ARG ANALYSIS_COMPONENTS=rea,js,native,android,protocol
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG REVERSE_DOWNLOAD_PREFIX=
RUN WORMHOLE_NPM_REGISTRY="$NPM_REGISTRY" PIP_INDEX_URL="$PIP_INDEX_URL" WORMHOLE_REVERSE_DOWNLOAD_PREFIX="$REVERSE_DOWNLOAD_PREFIX" python3 scripts/install-reverse-runtime.py --components "$ANALYSIS_COMPONENTS"

FROM core AS fingerprints
COPY --from=fingerprint-build /fingerprint-engine /opt/wormhole/pihost/vendor/fingerprint/fingerprint-engine
COPY pihost/resources/fingerprints/ /opt/wormhole/licenses/fingerprints/

FROM analysis AS analysis-fingerprints
COPY --from=fingerprint-build /fingerprint-engine /opt/wormhole/pihost/vendor/fingerprint/fingerprint-engine
COPY pihost/resources/fingerprints/ /opt/wormhole/licenses/fingerprints/

FROM analysis-fingerprints AS test-analysis
COPY --from=network-build /usr/local/go/ /usr/local/go/
RUN apt-get -o Acquire::Retries=2 update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=test WORMHOLE_REVERSE_INTEGRATION=1
COPY pihost/tests/ ./tests/
COPY web/src/ /opt/wormhole/web/src/
COPY pihost/tsconfig.json ./

# Plain docker build produces the core platform.
FROM core AS default
