---
name: wormhole-rea-toolkit
description: The complete capabilities of the REA reverse engine on Linux - native binary decompilation and cross-reference, Android APK structure and class analysis, JS anti-obfuscation, Go/Rust/PE/firmware/packet capture and other format identification, evidence packages. When you need to see the binary, so, APK, firmware or packet capture, you don’t have to rely on guesswork or black boxes. Use the tools here to extract evidence and continue verification.
mcps: [rea]
---

# REA Toolbox

First call analysis_capabilities to confirm the native capabilities; when components are not configured or missing, they are processed according to the return status, and it is not assumed that all backends are available.

The backend is subject to analysis_capabilities and actual call results. The tool catalog contains optional devices and commercial providers. The fact that tools can be retrieved does not mean that all dependencies have been deployed. Native sessions are isolated by Worker, and by default only one can reside at the same time; after completion, close_binary is called to release analysis resources. Idle sessions will be closed, and you need to open_binary again to continue analysis.

After loading this Skill:

-`SearchExtraTools {query}`search tool, **all words must hit** (AND). Use the words in the tool name:`android package`,`procedure pseudo`,`evidence bundle`,`javascript`
-`ExecuteExtraTool {tool_name: "mcp__rea__<name>", params}`execution, parameters strictly according to the schema returned by the search

**The largest result will not be returned directly. ** REA leaves analysis results in evidence base beyond MCP response budget times`resource_constraint`. At this time, use`get_evidence_bundle {detail:"summary"}`to get the summary, and then press`evidence_id`to get the details.

But`resource_constraint`has two sources, don’t confuse them:

- **Result delivery exceeds budget**: The analysis is indeed completed, and the results are in the evidence library (`evidence_id`is readable);
- **Execution resource failed**: JVM has insufficient memory, native thread creation failed, insufficient capacity, etc. The analysis **has not been completed**. At this time, do not promise the user that "the results are all in the evidence base", handle it according to the resource/diagnostics/limitations in the error, and reduce the task size and try again if necessary.

## 1. Native binary (ELF/.so/PE)

Only one is opened at the same time. Subsequent calls will act on the "current app" and there is no need to pass`document`.

| Purpose | Call | Measurement |
| --- | --- | --- |
| Open |`open_binary {path}`| By sample and hardware changes, return format / kind / sha256 / architecture |
| Global Overview |`binary_overview`| By Sample and Hardware Changes |
| Function table |`list_procedures`| 104ms |
| Decompile a single function |`procedure_pseudo_code {procedure:"0x102000"}`| 59ms |
| Function closer |`analyze_function {procedure}`| 106ms |
| Cross Reference |`xrefs {address}`| 45ms |
| Call graph |`get_call_graph {address}`| 50ms |
| Find string |`search_strings {pattern, mode}`| mode can only be`literal`or`regex`|
| Find bytes |`search_bytes {pattern:"7f454c46"}`| 66ms |
| Read memory |`read_bytes {address, length}`| 48ms |
| Segment table |`list_segments`| 85ms |
| Memory layout |`inspect_binary_layout {path}`| 697ms (pwntools) |
| objdump | `inspect_with_objdump {path, operation}` | 385ms |

`operation`values:`file_headers`,`section_headers`,`symbols`,`relocations`,`dwarf`,`disassemble`,`disassemble_all`,`architectures`.

Also:`list_names`,`set_comment`,`comment`,`set_bookmark`,`address_to_file_offset`,`resolve_containing_procedure`,`batch_decompile {addresses:[...]}`,`compare_functions`.

Typical uses: Look for communication encryption, signature verification, and anti-debugging in`libxxx.so`to see which system calls and strings it references.

## 2. Android APK

| Purpose | Call | Measurement |
| --- | --- | --- |
| Package structure |`inspect_android_package {path}`| 7.5~Changes by sample and hardware |
| Search category |`search_android_classes {path, query}`| 267ms |
| Look at individual classes |`inspect_android_class {path, class_name}`| By sample and hardware changes |
| Citation Tracking |`trace_android_references {path, class_name}`| — |
| Resource decoding |`decode_android_resources {path}`| By sample and hardware changes |
| Client self-test |`inspect_apktool_client`| 150ms, reported Apktool 3.0.3 |

For hardened and obfuscated APKs, this set has one more layer than "decompiled grep text": class relationships, method references, and original resource values can all be obtained directly.

## 3. JS/Web

| Purpose | Call | Measurement |
| --- | --- | --- |
| Unpacking and anti-obfuscation |`recover_javascript_sources {path, output_directory}`| According to sample and hardware changes, output`modules/*.js`+ sourcemap (Wakaru) |
| Page capture script |`analyze_web_bundle {cdp_endpoint, target_id}`| CDP page to be run |
| Static application diagram |`analyze_javascript_application {input_path}`| Only accept **directory** or`.asar`; the result is the evidence package |

For the complete process of front-end encryption, see`wormhole-web-reverse`.

## 4. Other formats

| Format | Tools | Status |
| --- | --- | --- |
| Any product identification |`inspect_artifact`| ✅ 64ms |
| Go Binary |`inspect_go_binary {path}`| ✅ 142ms |
| Rust Binary |`inspect_rust_binary {path}`| ✅ Available |
| PE Resources |`inspect_pe_resources {path}`| ✅ Available |
| Flutter judgment |`identify_flutter_build {path}`| libflutter package required |
| Dart AOT |`inspect_dart_aot {path}`| Same as above |
| Firmware Section |`inspect_firmware_regions {path}`| ✅ Available |
| Firmware Unpacking |`extract_firmware {path, output_directory}`| ✅ Available |
| Packet capture analysis |`inspect_packet_capture {path, fields}`| pcap file required |
| Product comparison |`compare_artifacts {left, right}`| ✅ Available |
| Universal unpacking |`extract_artifact {path?}`| ✅ Available |

## 5. Evidence package (the key to getting big results)

| Tools | Purpose |
| --- | --- |
|`get_evidence_bundle {detail:"summary"}`| List the analysis records retained by this session |
|`export_evidence_bundle {path}`| Export to file (actual measurement: 36ms) |
|`import_evidence_bundle {path}`| Import ready-made evidence, no need to re-run analysis |

`analyze_javascript_application`and large-scale`batch_decompile`. If the response is "result over budget", the real result is here; if the response is failure to execute resources, there will be no result here. The resource must be resolved first or the task must be split.

## 6. Not available on this machine

It's not that the tool is broken, it's that it lacks dependencies or the platform doesn't support it. If`capability_unavailable`is reported, just change the path directly. Do not adjust parameters repeatedly:

| Branch | Reason |
| --- | --- |
| Android ADB Family Bucket (about 24) | No adb installed, no connected device |
| Frida (9) | No frida installed, no equipment |
| GDB / Rizin / Cutter (11) | None installed |
| JEB decompilation (4) | JEB is commercial software |
| iOS / macOS related | Some capabilities are only available on macOS |
|`inspect_wasm_artifact`| Version banner for native wabt 1.0.39 is not accepted |
|`inspect_sqlite_database`| REA has additional requirements for the Node SQLite interface |

## 7. Calling discipline

-`capability_unavailable`= Missing dependencies, change path;`target_unavailable`(such as "No app is open") = Not yet`open_binary`;`invalid_request`= Wrong parameters or targets
- Only open one binary at a time, change the target first`close_binary`
- For large files (tens of MB or more), first`inspect_artifact`to see the structure, do not directly`binary_overview`
- The analysis conclusion must be written back to the exploration graph using`record_fact`, with the file sha256 and key function addresses, otherwise the next worker will have to rerun
