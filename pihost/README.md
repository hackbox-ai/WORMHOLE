# WORMHOLE API and Agent host

This directory is responsible for HTTP API, business modeling, task orchestration, session execution, tool gating, persistent events, auditing, browser, traffic and static front-end hosting.

The main deployment entry is the root directory [Docker Compose](../README.md). Standalone development requires Node.js >=22.19.0, PostgreSQL, OpenSSL, and a browser.

```sh
npm ci
npm run typecheck
WORMHOLE_CONFIG=/absolute/path/config.dev.json npm run dev
```

Configuration example (configuration files and credentials are not submitted to Git):

```json
{
  "listen": {"host":"127.0.0.1","port":18887},
  "database": {"dsn":"postgres://wormhole:YOUR_PASSWORD@127.0.0.1:5432/wormhole"},
  "dataDir":"/absolute/path/data",
  "pi": {"agentDir":"/absolute/path/agent","modelsPath":"/absolute/path/agent/models.json","provider":"","modelId":""}
}
```

`models.json`is created for the first time with the content`{"providers":{}}`. Model configuration is managed through pages.`WORMHOLE_WEB_DIST`specifies the static directory;`WORMHOLE_TOOLS_DIR`specifies the local extension tool root directory.

-`src/api/`: routing, authentication, SSE and static pages.
-`src/domains/`: Business module;`tasks/engine.ts`is responsible for task scheduling and cancellation.
-`src/pi/session-host.ts`: Pi session adaptation, model configuration, tool and event access.
-`src/domains/extensions/`: Extended availability and tool assembly boundaries.
-`migrations/`: New database initialization and subsequent orderly migration.
-`builtin-skills/`: Basic methods and Web workflow; optional Skill is in the root directory`extensions/skills/`.

Tests must explicitly set the standalone configuration:

```sh
WORMHOLE_CONFIG=/absolute/path/config.test.json npm test
```

Data, model files, sessions, work files, evidence, and traffic should be backed up. The semantics of pausing/stopping tasks and stopping human-machine dialogue follow the existing product process.
