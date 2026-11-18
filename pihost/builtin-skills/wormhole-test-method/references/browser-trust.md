# CORS, CSRF, Host and Redirect

## CORS
Own private resource baseline, control the second origin real browser to send requests with credentials, check whether preflight/actual ACAO/ACAC/Cookie SameSite and JS can read the private canary. Being able to read Origin reflection, *, and curl does not mean that the browser is leaking. It may be normal for the public API to allow cross-domain.

## CSRF
Own recoverable state, legitimate request → missing/wrong/another session token → controlled site browser request; check Cookie, SameSite, Origin/Referer and real state changes. Tokens sent anonymously and JSON API without credentials cannot be reported separately.

## Host/Open Jump
Capture reset link, absolute location, callback, cache key baseline, controlled Host/forwarded variant to check real mail/jump/cache. Only the local machine can be directly connected to control the Host, and the attack prerequisite must be written.
Whether the controlled jump domain name actually receives its own code/token, allowing business external links to be separated from the outbound sending of sensitive credentials. Ordinary jump is not a takeover.

## CRLF
If there is evidence of entering the header field, try encoding and wrapping again, and check whether the original bytes are new headers/messages instead of escaping echo; do not open other people's requests in the shared connection. Caching effectiveness independently verified.
