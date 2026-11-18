---
name: wormhole-native-review
description: Reverse analysis of IPA/Mach-O, ELF/PE executables, APKs, .NET assemblies, and firmware packages. Backend analysis by actual installation via REA MCP.
mcps: [rea]
---

# Binary and mobile reverse engineering

First call analysis_capabilities to confirm the native capabilities; when components are not configured or missing, they are processed according to the return status, and it is not assumed that all backends are available.

REA provides a unified tool entrance. The specific format and operation depend on the installed backend. Android/JEB/device debugging and other branches cannot be judged based on the tool name alone; they are processed based on the capability detection and execution results.

Usage:`SearchExtraTools`Search by tool name or purpose, get the schema and execute it with`ExecuteExtraTool`.

## Product → Entry

| Products | Entrance |
| --- | --- |
| IPA / Mach-O |`extract_artifact`unpack →`open_binary`main program |
| ELF/PE executable |`open_binary`|
| APK | `inspect_android_package` → `decode_android_resources`、`inspect_android_class`、`decompile_jeb_item` |
| .NET Assembly |`inspect_managed_artifact`,`inspect_managed_members`|
| Go/Rust compiled products |`inspect_go_binary`,`inspect_rust_binary`|
| Firmware / Unknown Container |`extract_artifact`,`inspect_artifact`|

## After opening

| Purpose | Tools |
| --- | --- |
| Overview (architecture, segments, number of functions, number of strings) |`binary_overview`|
| Decompile pseudocode |`procedure_pseudo_code`|
| Compilation |`procedure_assembly`|
| Function list / Search by name |`list_procedures`,`search_procedures`|
| String/Symbol |`list_strings`,`list_names`|
| Calling relationship |`get_call_graph`,`trace_call_path`,`procedure_callers`,`procedure_callees`|
| Cross Reference |`xrefs`,`procedure_references`|
| Read memory or file bytes |`read_bytes`|
| Closing |`close_binary`|

## IPA

IPA is zip. After`extract_artifact`is unpacked, the main program is located under`Payload/<Name>.app/`. The file name is based on`CFBundleExecutable`of`Info.plist`in the package (usually the same name as the`.app`directory, but not always), and the rest are Framework and`.dylib`.

`open_binary`This Mach-O is ready for analysis - Ghidra comes with a Mach-O loader and AARCH64 decompiler.

## Native capability boundary

macOS-specific operation returns`unsupported_host`on Linux:

`inspect_macho`、`list_architectures`、`demangle_swift`、`inspect_signature`、`inspect_plist`、`observe_native_calls`、`capture_native_ui_scenario`

Ghidra path coverage equivalent information (segment, symbol, string, pseudocode). Swift symbols remain mangled.

## Product characteristics

1. Pseudocode is not the original source code, variable names, types, and control flow may be distorted; conclusions must be verified on the real target before`report_finding`.
2. The analysis is completed in a temporary project, the annotations and comments after`close_binary`are not retained, and the original binary file is not modified.
3. The IPA distributed by the App Store is encrypted by FairPlay, the`__TEXT`segment is ciphertext, and static analysis can only see the shell.
