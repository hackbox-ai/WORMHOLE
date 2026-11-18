# Assets and Scope

## Add assets

The asset module manages enterprise, domain name, IP, URL and other information. The task asset list manages the test assets and scope relationships of the current task. When adding a range, you can enter domain name, IP, CIDR, ICP or keywords one line per line.

Domain names and IPs can create or reuse global assets; CIDR, ICP, and keywords can also serve as scope context for Agents.

## Enterprise ownership

ICP in the enterprise scope is used for exact matching. Enterprise keywords are provided to the Agent as clues and all matching text will not be automatically attributed as enterprise assets.

When creating a task, associate an enterprise to add the currently existing assets of the selected enterprise to the task test assets and provide scope context. It does not automatically generate all test intents, nor should it replace task objectives.

Editing an enterprise scope replaces the existing scope, appending retains the old scope. Relevant confirmation prompts remain on the operation page.

## Associated tasks and coverage

Persistent blackboards, scopes, and related traffic directly associated with tasks can be used as read-only sources of information, and new tasks are written to independent contexts. The coverage view displays the scope and relationship, and the coverage ratio should be judged based on the actual test evidence of the task.

## External synchronization

Asset synchronization relies on the corresponding data source and MCP connection. After creating the data source, you need to fill in the address, key and enable it; check whether it is completed with the connection status and actual synchronization results.
