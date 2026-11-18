# Authentication, session and credential change chain

## Link building
Login/register/retrieve password/bind/2FA/token exchange respectively draw challenge→identity certificate→temporary credentials→final change/session issuance. Record the account number, purpose, tenant, device, validity period, and one-time requirements of the credential; sending verification codes anonymously is usually a normal function.

## Control
1. Use your own test account to follow the legal chain, and use me + your own private resources to prove your identity.
2. The key steps are valid, error, null value, missing field, no pre-challenge, expired and used proof. One variable at a time, other request fields are valid.
3. Finally, change the encryption/binding interface to check whether the pre-certification can be omitted, and whether the account/purpose/token can be replaced; the change is only allowed and recoverable for dedicated accounts.
4. Whether the session is updated after logging in, whether the old token becomes invalid according to business requirements after logging out/changing the password, and whether the A/B session is shared. Actual access to protected resources, not just comparison of token strings.
5. 2FA challenge/verification code/final session binding; "Verification code passed" does not mean that the entire authentication passed.
6. Create resource matrices for anonymous, installation/device, business user, and administrator token purposes respectively; valid tokens do not mean that they can cross scopes.

## Service account and throttling candidates
Passwords for service/device/integrated accounts are often generated according to deducible rules during initialization. When the entrance has continuous failure penalties (incremental delay, speed limit, temporary locking), first record the form and rhythm of throttling feedback (first feedback, interval requirements for retry), and do not infer the complete locking strategy from a small number of attempts; massive guesswork is not feasible in terms of budget when throttling exists. Change to a small candidate set: collect naming materials from the visible text of the target itself - initialization announcements, operation and maintenance documents, archived materials, equipment labels, organization numbers, date and period writing habits - generate dozens of combinations according to delimiters, capitalization and suffix variations, sort by possibility, serially verify the same account, the interval is not less than the minimum observed interval, share the attempt progress within the task, and do not repeat rejected candidates. Confirm the naming rules on your own test assets first, and then use them on other subjects; the idea is consistent with CeWL, and the vocabulary comes from the site content rather than a general dictionary. After the derivation is successful, first access the identity interface to confirm the obtained subject and permissions, and the session is reused within the task; the candidate is just a hypothesis, and the successful verification still ends with actual access to the protected resource.

## Criterion
Error/missing attestation is only supported after establishing an unintended authorization test identity, performing a protected action, or actually changing credentials. HTTP200/status=0, successful registration, weak password policy/missing HttpOnly cannot alone prove authentication bypass. The risk of lockout or non-recoverability occurs and the path is stopped immediately.
