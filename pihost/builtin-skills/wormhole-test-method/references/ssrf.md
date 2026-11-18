# Server request and callback attribution

## Entrance
URL preview/file import/screenshot/PDF/Webhook/callback/JWKS/object return to origin. First obtain your own normal test resources. Client jump is not equal to server access.

## Steps
1. Each parameter/experiment uses a unique controlled token/path, associated with the send/callback time, protocol, method, source IP, UA and real traffic.
2. Do not submit URLs, invalid URLs, and local view callback URLs as controls, excluding browser prefetching, email scanning, analysis tools, and proxy/manual clicks.
3. DNS-only description parsing, HTTP certification request, and reading the body requires additional certification; in the end, 400 may still send a network request first, and the two are recorded separately.
4. Only when there are allowlist clues can the approved domain name be compared, jump to another controlled domain, different protocols/ports in the same domain, and make it clear which hop the verification occurs. DNS rebinding is only available in approved isolation environments.
5. The impact only uses the internal canary within the scope, and the proof returns the body/controllable method header/includes the identity and network boundary; the external station GET does not infer cloud metadata/the entire intranet.
6. After there is actual evidence that the object "returns to the source if it does not exist", use your own isolation key to compare the presence/absence; a special race-reading project is required, and unknown objects are not deleted.

## Criterion
DNS/HTTP/echo/internal reads each state capabilities; screenshots or scanner tags are not evidence. It is prohibited to use unauthorized intranet scanning to expand the impact.
