# Optional extensions

The WORMHOLE base platform can independently launch and perform common web security tests. The optional extension page displays whether components and data are available, and provides respective configuration entries.

- ScopeSentry: Configure your own services and credentials on the asset synchronization page.
- White box code analysis: configure independent service addresses and tokens, enable indexing and auditing on demand.
- REA, native program, Android and protocol analysis: The administrator installs the corresponding tool chain and completes authorization on the MCP/Skill page.
- PoC: Import your own knowledge sources, or add entries manually; the knowledge base does not automatically execute templates.
- Fingerprint: The administrator installs the matching engine and the user imports the rules. Data can still be managed without an engine.

Not installed, not configured, disabled, data empty and connection exception are different states. The absence of extension does not mean that the target is not vulnerable, nor does it require the entire task to be suspended. Installing the Skill will not install dependent services; installing services does not mean granting Agent permissions.

Please see the project warehouse`docs/extensions.md`for server deployment details.
