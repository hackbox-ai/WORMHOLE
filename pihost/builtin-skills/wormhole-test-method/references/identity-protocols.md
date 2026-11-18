# JWT, OAuth/OIDC and SAML

## JWT
Record the alg/kid/issuer/aud/sub/scope/exp and resource baseline of the own token, and the decoding is normal. Change signature, algorithm, expiration, aud/issuer or usage at one time based on source code/configuration clues; prove true identity after acceptance by me/protected operation. kid/jku/x5u only uses controlled test keys/endpoints to check trust boundaries and does not explode keys; successful formatting/decoding does not mean successful authentication.

## OAuth/OIDC
1. Capture the client/redirect_uri/state/code/PKCE/nonce and token exchange chain of your own account.
2. State missing/error/another self-owned session shall be verified separately; code one-time, expired, client/redirect/session binding shall be checked one by one.
3. The controlled callback checks the exact match of the redirect and actually sends its own code/token; ordinary open redirect does not equal login hijacking.
4. Compare normal verifier, error verifier, and missing verifier; judge PKCE requirements according to client type, and do not necessarily identify all confidential clients as vulnerable.
5. The consumer verifies the ID token signature/issuer/aud/nonce and the access token purpose/scope, and has two test clients/sessions to cross-replace and read the identity.

## SAML
Establish a baseline of legal own Response; check that the signature coverage object is consistent with the Assertion read by the consumer, and Audience/Recipient/Destination/InResponseTo/Validity/Replay binding. Missing/tampered/packaged candidates must be accepted by the consumer and establish an unexpected authorization test identity; XML decoding/error stack is not considered successful.

## Output
Which credential crosses which constraint at which consumer end, real identity and independent operation evidence desensitized records; configuration missing and actual effect are separated.
