---
name: wormhole-code-review
description: Target code (source package, tar, jar, APK, Go executable, wxapkg) can be indexed after the code analysis service is enabled; use the tools here to retrieve the source code or initiate a static audit.
---

# Target code

First call analysis_capabilities to confirm the native capabilities; when components are not configured or missing, they are processed according to the return status, and it is not assumed that all backends are available.

The source code package,`.tar.gz`,`.jar`,`.apk`, Go compiled executable file,`.wxapkg`that appears in the workspace will be recognized by the platform; code index will only be created when the code analysis service has been configured and indexing is enabled, and "Code Index Established" will appear in the exploration map.

Files can be directly dropped into the workspace using`download_file`, downloads are always available, and indexing requires services to be available.

## Tools

| Tools | Function |
| --- | --- |
|`download_file(url, name?)`| Streaming download any file to the working directory, return path, size, sha256, type; large files will not be entered into the context |
|`list_target_sources()`| Code source list and audit status (unaudited/in progress/audited/failed/timed out) |
|`list_target_code(dir?)`| File List |
|`search_target_code(pattern, source?, limit?)`| Regular search (ignore case), return path:line and matching lines |
|`read_target_code(path, source?)`| Read single file,`.class`/`.dll`automatically decompile |
|`audit_target_code(source?, focus?)`| Initiate static audit and produce clue facts |

When using multiple code sources, first use`list_target_sources`to view the candidates (each item has a unique id): if you do not pass`source`, it will only return the candidate list and will not guess one for you; just pass this id to`source`when specifying. It does not need to be transmitted when there is only one source.

## Typical usage

```text
list_target_sources → What codes are there and have they been reviewed?
search_target_code("api/orders")         → app.py:128
read_target_code("app.py") → See authentication and parameter processing
```

`list_target_sources`before auditing:`done`will not run again,`failed`/`timeout`can be retried, change the angle and recheck with`focus`.

## NOTE

1. The decompiled product is a clue. The path, parameters, and authentication are subject to actual measurement.`report_finding`can be performed after confirmation.
2. Decompilation may be lossy (variable names, types, control flow), and native libraries and Go structure fields are more distorted.
