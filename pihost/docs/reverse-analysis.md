# Reverse and code analysis

This module retains access to local analysis tools and independent code services. The base image does not carry a complete reverse tool chain, nor does it start or automatically register REA.

- Use compose.analysis.yaml to build optional images, and you can select rea, js, native, android, protocol through ANALYSIS_COMPONENTS.
- Explicitly install the corresponding Skill through npm run extensions, and then configure, detect and authorize the service on the MCP page.
- The local directory is specified via WORMHOLE_TOOLS_DIR; the CLI and capability detection use the same path.
- Native, Android, protocol backend independent detection; remote REA does not require the application container to also install the local engine.
- External white box services are configured via address, token, index and audit switches, the service implementation is not in this repository.

For complete command, path and data access instructions, see the root directory docs/extensions.md. File existence, connection success and actual analysis completion are verified separately, and static clues still need to be confirmed by test evidence.
