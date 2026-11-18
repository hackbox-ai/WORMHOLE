#Special test index

Load the matching method according to the current entry characteristics and do not read the entire set at once. Each item performs normal baseline, univariate experiment, negative control and actual effect verification; different screening parameters/positions/operations for the same interface are recorded separately.

| Trigger Features | Methods | Core Validation |
| --- | --- | --- |
| SPA/chunk/sign/Encrypted ID/Unlisted Address | [JS Interface and Signature](${SKILL_DIR}/references/js-recon.md) | List of legal signatures and interfaces |
| User/Tenant/Order/Attachment ID | [Object Authorization Matrix](${SKILL_DIR}/references/object-authz.md) | A/B/Anonymous × OA/OB/OX |
| role/owner/tenant/price field | [Mass assignment](${SKILL_DIR}/references/mass-assignment.md) | Repeat persistent status and real permissions |
| Login/Change/Bind/2FA/Service Account Throttling | [Authentication and Session](${SKILL_DIR}/references/auth-session.md) | Pre-certification and final status |
| Missing identity/robots forbidden directory/archive migration | [Exposure and components](${SKILL_DIR}/references/exposure-components.md) | Deploy legacy clues and identity materials |
| 401/403/400/405, path variant | [Filter layer and controller](${SKILL_DIR}/references/filter-gateway.md) | Legal body, SPA exclusion, ordered variant |
| Query/sort/filter JSON | [Query injection](${SKILL_DIR}/references/query-injection.md) | True/false conditions and canary |
| Templates/EL/System Commands | [Template and Command](${SKILL_DIR}/references/template-command.md) | Actual harmless evaluation/execution |
| URL/Preview/Callback/JWKS | [SSRF](${SKILL_DIR}/references/ssrf.md) | DNS/HTTP attribution and impact boundaries |
| HTML/DOM/Rich Text | [XSS](${SKILL_DIR}/references/xss.md) | Context and browser actual execution |
| Upload/Download/STS/Pre-signed | [File and Object Storage](${SKILL_DIR}/references/files-storage.md) | Complete chain and attribution/path boundary |
| JWT/OAuth/OIDC/SAML | [Identity Protocol](${SKILL_DIR}/references/identity-protocols.md) | Signature and Purpose/Session Binding |
| FIDO/Passkey | [WebAuthn/FIDO](${SKILL_DIR}/references/webauthn.md) | challenge/RP/Account Binding |
| SMS/email/Magic Link | [Messages and one-time credentials](${SKILL_DIR}/references/messages.md) | Delivery, binding and final authentication |
| Order/coupon/points/approval | [Business invariant](${SKILL_DIR}/references/business-logic.md) | Server settlement and status chain |
| One-time/idempotent/TOCTOU | [Race](${SKILL_DIR}/references/race.md) | Serial → Small concurrency → Final ledger |
| Multi-step processing/derived credentials/authority revocation/accumulated amount | [Process and status analysis](${SKILL_DIR}/references/workflow-analysis.md) | Parent-child objects, issuance consumption binding, representation conversion and persistent state; offline tools do not replace real verification |
| GraphQL/WebSocket | [Query and Real-time Protocol](${SKILL_DIR}/references/graphql-websocket.md) | resolver/Message item-by-item authorization |
| CORS/CSRF/Host/redirect | [Browser Trust Boundary](${SKILL_DIR}/references/browser-trust.md) | True cross-site reading and writing |
| CDN/cache/HTTP2/framing | [Caching and parsing](${SKILL_DIR}/references/cache-http.md) | Clean independent request reproduction |
| XML/XSLT/Serialization/Deep Merge | [Parser](${SKILL_DIR}/references/parsers.md) | Input can achieve sink and actual effect |
| SCM/Keys/CVE/DNS | [Exposure and Components](${SKILL_DIR}/references/exposure-components.md) | Content/Scope/Deployment Prerequisites |
| Cloud assistant/execution tool | [Agent execution boundary](${SKILL_DIR}/references/agent-execution.md) | Real execution and independent isolation impact |

## Overwrite and stop

NEW Not tested; TESTING under verification; DONE has normal baseline, applicable experiments and controls; BLOCKED lacks identity/tools/front-end; DEFERRED is over budget or low priority. Capturing traffic, reading JS and an interface of 200 does not equal the entire category of DONE. Two rounds of no gain stop the same assumption, retain other applicable types, and do not limit the entire task to three requests.

## Experiment handover

Each result saves principal/role/tenant, object ownership, method/parameter location, normal requests, unique changes, negative comparisons, actual private tags/final state, recovery, budget and unmeasured boundaries. Enumeration, authentication, object authorization, persistent writing, execution, impact are different conclusions. If there are no matching business characteristics, special items will not be forcibly selected.
