# WebAuthn/FIDO state binding

## Link building
FIDO2 options/result is separated from FIDO1 Reg/Auth/Dereg, recording the account number, RP/App, origin, challenge, session, credentialId and version; for your own account, use a browser/test authenticator to complete the legal chain.

## Method
1. options: compare allowCredentials/excludeCredentials, size/delay/business errors between own registered accounts and random accounts that do not exist, low-frequency repeated noise elimination; the empty array may be a privacy design, and credentialId is not a private key.
2. Registration options→result: Verify challenge one-time/expiration and account/session/RP/origin binding in your own recoverable account, one field at a time. fmt:none may be a legitimate strategy, and it requires follow-up only if it lacks cross-account binding.
3. After the result is successful, reread the credential list, and then log in with a real assertion; the persistence, login, and administrator permissions are proved in stages and will not be taken over from the registration inference platform.
4. The assertion checks challenge/origin/rpIdHash/userHandle/signature and UV/UP according to the actual process. The synchronous passkey count is judged based on semantics, and the fixed count is not bypassed separately.
5. FIDO1 first confirms the version support and verifies the Reg/Auth/Dereg status respectively; 500/sessionId echo/abandon routing fails.

## Constraints
Credential additions and deletions are only for dedicated accounts and existing licenses, and the path needs to be cleared; tenants within the scope are individually verified, and closing tenant registration does not equal a global patch. Declare the broken links and their real impact.
