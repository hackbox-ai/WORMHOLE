# Detailed report structure

The following chapters can be adjusted according to the vulnerability type; the descriptions of chapters without evidence are unknown or inapplicable and cannot be fabricated using templates.

## Overview
Vulnerability name, affected functionality, basis for identification, and current limitations.

## Test scope and preconditions
Target address/component version, test identity, permissions, object ownership, configuration that must be enabled.

## Actual impact
Confirmed new capabilities, affected object boundaries, and unconfirmed extension chains. Severity and CVSS vectors are itemized; don't write off low-privilege, user-interaction, and high-complexity premises.

## Reproduction steps
Numbered steps document preparation, legal baseline, changing variables, negative controls, observations, and necessary controlled cleanup. Each step can be mapped to the actual execution record; the body code block only displays verified requests/commands, and sensitive values use placeholders.

## Evidence
Real traffic/binding/trace/attachment references, most probative request/response or command output. Separate expectations from reality; screenshots or captions are not enough to prove business overstepping boundaries. Non-HTTP vulnerabilities identify their source of evidence.

## Root cause and repair
The file/line number can only be given after reading the source code; black box inference annotation inference. It is recommended that WAF is not generally recommended for actual mechanisms such as permission verification, binding, parsing, and state machines.

## Retest suggestions and restrictions
Baseline, original PoC, adjacent variants, and clear passing criteria need to be preserved. List unverified, environmental dependencies and evidence gaps, and do not write untested areas as safe.

## Complete the evidence according to the mechanism

| Type | Must be present in report | Not a substitute for evidence |
| --- | --- | --- |
| Object/tenant exceeds authority | A/B identity and ownership, legal/cross-subject/non-existent request, private tag or write status of B repeat | Only 200/total changes |
| Authentication chain | Each step challenge/credential usage, error proof control, final identity or own credential changes | Verification code success/link issuance |
| Query injection | Parameter position/language context, true/false conditions, limited canary difference | Error reporting/single delay |
| Upload/Path | Save→Access→Processing, Attribution and Actual Content | Accept Suffix/Path Echo |
| SSRF | Independent token, time, DNS/HTTP original callback, negative comparison and network boundary | Scanner tag/external station request push intranet |
| XSS | Input context, browser action, actual markup, stored second viewer | String reflection/self-console |
| Business/Competition | Serial expectations, minimum concurrency, each response, final ledger and recovery | Two successes |
| Agent execution | tool-use/result audit, execution location, independent isolation impact | Model self-proclaimed execution/sandbox id |

Reproduction steps retain specific methods, field positions, and desensitization requests, and do not pile tool names into steps; "Execute scan → Discover vulnerabilities" is not a reproducible report. Confirm capability and impact segmentation, and only score points for confirmed C/I/A.
