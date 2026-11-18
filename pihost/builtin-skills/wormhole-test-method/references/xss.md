# XSS and browser context

## Identification
Verify that input falls into HTML text/attributes, JS strings, URLs, CSS, or DOM sinks, and trace raw responses to DOM encoding/sanitization. Reflection/dangerous functions/HTML acceptance are not equal to execution.

## Verify
1. Normal tag establishment path, use harmless console/test DOM attribute/title tag according to context; record browser, CSP, identity and trigger action.
2. Reflective comparison can execute experiments, escaped comparisons and non-existent inputs; it is only valid when the actual target origin is executed, and manual execution on the console does not prove it.
3. In the storage type, A writes its own test object, and B authorizes the test identity to be viewed on the normal page; the persistent content and B's actual execution are saved, and then cleaned up.
4. DOM type and location/hash/message to innerHTML/eval/URL; postMessage checks origin/source and receiver permissions.
5. CSP/dangling markup, etc. are only expanded according to the actual context; lack of CSP does not equal XSS, and no real token/private text is sent to external sites.

## Criterion
Exclude self-executing, plain text, unreachable content, and administrator-allowed templates. Explain the real subject and triggering conditions, and mark the execution without directly upgrading the account takeover.
