# Audit checklist from entry to dangerous operations

## Fixed version and entrance
Record commit/build, route registration, deployment configuration, identity middleware, dependency locks and function switches. From real external requests/messages/files to handler tracking, test directories/unregistered functions/unenabled components cannot be reachable in production.

## Check by mechanism
| Mechanism | What to check in the code | Minimum running proof |
| --- | --- | --- |
| Object/tenant authorization | Whether to bind actor/tenant after searching by id; whether list filtering is used for attachments/exports; batch item-by-item authorization | A/B dedicated canary and non-existent objects |
| Mass assignment | DTO allows fields, objects to spread/merge, ORM updates, role/owner/status | Independent read/permission operation after low-privilege write |
| Authentication chain | Challenge storage key, purpose/account/session binding, whether the last interface is verified, token consumption | Error/missing certificate and actual identity |
| SQL/NoSQL | Splicing/dynamic sorting/operator parsing, whether parameterization covers each field | Restricted canary true/false conditions |
| Template/Command/EL | User input enters eval/render/shell or argv; filtering location | Independent harmless marker and stdout |
| Path/Upload | Containment, soft link, decompression entry, pre-signed policy after resolve/normalize | Canary inside and outside the approved directory |
| SSRF | URL resolution, per-hop redirects, DNS resolution/IP checks, proxies, downstream credentials | Controlled unique callbacks with independent effects |
| XML/deserialization | parser security options, class whitelist, dependent gadget, actual call | Isolation environment harmless effect |
| Prototype/type | Deep merge key restriction, inherited attribute reading, relaxed comparison | Independent object marker/real state |
| Race | Check and write in the same transaction? Lock/unique key/idempotent key/retry window | Serial comparison, small concurrency final ledger |
| Cache/Protocol | Whether the key contains identity/host, poor front-end and back-end parse, response cache strategy | Clean reread of isolated key |
| Agent Tools | Role Visibility, Final Parameter Review, Attribution Context, Sandbox Boundaries | Auditing and Cross-session Canary |

## Patches and Variants
Find missing constraints in historical patches instead of searching for the same function name: check with another method in the same namespace, batch/export/attachment, another protocol, asynchronous worker and background entry respectively. Confirm whether the patch has been moved back to the current version and whether the function is enabled. Each candidate write file: line number, source, propagation, filtering/authentication, sink, reachability premise and counter-evidence. If the operating environment is missing, you can only mark it as a candidate and cannot claim to have used it.
