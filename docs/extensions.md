# Optional extension deployment

The base platform does not automatically download, import, or enable optional tools and full data packages. Configuration, availability and Agent authorization are managed separately; when expansion is abnormal, the task continues in other executable directions.

## Skill installation

```sh
docker compose exec wormhole npm run extensions -- list
docker compose exec wormhole npm run extensions -- install scopesentry
docker compose exec wormhole npm run extensions -- install whitebox
docker compose exec wormhole npm run extensions -- install rea
docker compose exec wormhole npm run extensions -- install protocol
```

The install operation copies missing files and adds bindings for the specified role without overwriting user edits. Installing a skill does not install services or tools, nor does it bypass approvals and asset scopes.

## ScopeSentry

Set the service address and API Key on the asset synchronization page.`127.0.0.1`in the container is the container itself; the remote service uses the actual reachable address, and the same network container uses the service name. Check the connection before performing synchronization.

## White box service

Deploy your own analysis service that is compatible with the`pihost/src/domains/codeintel/client.ts`contract. Configure the address, token and enable indexing in "Reverse and Code Analysis"; automatic auditing can be enabled separately. The WORMHOLE repository does not contain the service implementation, nor does it provide a virtual mirror address.

## REA and local components

The external REA can configure the MCP for the transports it actually supports. stdio only executes commands within the application container; HTTP/SSE uses the container's reachable address. Target materials required for analysis services must be provided via file transfer or shared storage supported by both parties.

When local tools are required, an optional image can be built:

```sh
docker compose -f compose.yaml -f compose.analysis.yaml build --build-arg ANALYSIS_COMPONENTS=rea,js wormhole
docker compose -f compose.yaml -f compose.analysis.yaml up -d wormhole
```

Component optional`rea,js,native,android,protocol`.`native`includes Ghidra/JDK;`android`includes JDK, JADX bridge and Apktool;`protocol`includes Python protocol analysis dependencies. The default extension image builds all components, which is large and time-consuming. Component versions are script-locked and downloads support verification; the base image does not carry them.

Frida dynamic instrumentation is optional: Add`frida`to the build parameters (for example,`ANALYSIS_COMPONENTS=rea,frida`). The default REA installation retains the Linux PTY and skips Frida's optional source code build; Frida's host permissions, target processes, and environment need to be prepared by yourself.

Configurable`NPM_REGISTRY`,`PIP_INDEX_URL`, and`REVERSE_DOWNLOAD_PREFIX`build parameters when the network is slow. Tarballs still verify fixed SHA-256 and npm still verifies lock file integrity.

Install the corresponding Skill after building. Manually add REA on the MCP page: command`node`, parameters`/opt/wormhole/tools/rea/node_modules/rea-agents/scripts/rea.mjs`,`--mcp`; set environment variables according to`docs/user-guide/reverse.md`and the actual backend, refresh the tool and authorize the Agent. Platform startup does not automatically establish or re-enable this connection.

## PoC data

Import source package, complete knowledge base export package or add entries manually on PoC page. The source package uses the`wormhole-poc-source-v1`format (see`pihost/src/domains/pocs/catalog.ts`for structure) and supports nucleic and legacy-python static content. Native Nuclei YAML is not equal to the source package and needs to be sorted into the corresponding import format first.

Preserve data provenance, license, content, and version. This module provides reference knowledge and does not automatically execute Python or Nuclei templates. After the library is revised, new tasks use the new snapshot, and existing tasks retain the pinned snapshot.

## Fingerprint

Prefer using the optional image containing the matching engine:

```sh
docker compose -f compose.yaml -f compose.fingerprints.yaml up -d --build
```

When you need to include both local analysis tools and fingerprint engines, specify the build target as`analysis-fingerprints`; the complete rules are still imported by the user.

You can also compile the Linux x86_64 product yourself according to the Go version required by`pihost/fingerprint-engine/go.mod`, and specify the path through read-only mounting and`WORMHOLE_FINGERPRINT_ENGINE`.

Rules are imported in the EHole/Goby/Wappalyzer/Fingers/FingerPrintHub/ARL format on the fingerprint management page, or imported into the platform export package. Rules can be managed even if the engine is not installed. The recognition capability is enabled after both the engine and the rules are available.

Re-detect through "optional extension" and confirm access based on actual tasks. File existence, connection success and actual analysis success are different checks.
