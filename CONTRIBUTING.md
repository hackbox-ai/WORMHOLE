# Contribute WORMHOLE

Describe the specific problem, expected behavior, and verification results when submitting the change. New optional capabilities should continue to use MCP, Skill, HTTP or data import mechanisms, and basic startup should not rely on the existence of extensions.

- Use WORMHOLE/wormhole/WORMHOLE naming; do not introduce historical product configuration aliases.
- Tested with isolated database and data directory, configuration path provided via WORMHOLE_CONFIG.
- Add regression tests with actual behavioral assertions when changing task lifecycle, tool permissions or data persistence.
- Indicate versions and sources when changing data formats; retain third-party licenses and author acknowledgments.
- Run data, credentials, model configuration, and target response text are not submitted.
- Maintain docs/user-guide synchronously when modifying the user process, and the front-end build will generate offline help.

The original code of this project adopts [AGPL-3.0-only](LICENSE). Submitting a contribution indicates that you have the right to provide the corresponding content and agree that the original contribution will be published under this license. Third-party materials must retain their original copyrights and licenses; indicate the source and applicable licenses when submitting.
