# Filter layer, controller and path normalization

## Response layering
| Result | Candidate layer | Must continue checking |
| --- | --- | --- |
| 403 HTML/WAF template | Edge filtering | Normal routing/response fingerprint |
| 401 authentication error | Identity filtering | Valid token/scope |
| 403 AccessDenied | Role/Method Permissions | This identity operates legally |
| 400 JSON/field verification | Parser/Controller | Legal request body and own ID |
| 405 | Mapping/method mismatch | JS/OpenAPI real method |
| 200 text/html | SPA/login fallback | Type and private business tags |
| 200 JSON | Business success candidate | Object and actual cross-border effect |

## Ladder
1. First establish the controller fingerprint from the normal identity and legal request body. It is forbidden to use a large number of empty objects to POST 400, which will be counted as bypass; at the same time, status/body/type/Location/business status will be recorded.
2. If there is path filtering evidence, then select the order according to the actual stack: rewrite/forwarded header → slash/suffix → semicolon parameter → single encoding → double encoding → relative path/double slash → uppercase and lowercase / stack applies special characters; each category has a variant with explanatory value, not all arrangements.
3. The method, signature, CSRF, legal body and own object remain unchanged; the original path is rejected, the variant service is successful, and the path/object does not exist.
4. Token type × controller namespace × read-only operation creates a small matrix to distinguish authentication failure and scope failure. Read-through does not infer write-through, and subsequent writes comply with task constraints.

## Criteria and repair
Gateway/backend normalization difference is only supported if the real protected operation is reachable; SPA HTML, proxy parse error, 405 are not successful. Different tenants/versions/upstreams are recorded separately, and tenant shutdown functions do not equal global code fixes.
