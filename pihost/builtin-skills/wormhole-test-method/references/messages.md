# SMS, email and one-time credentials

## Test chain
Send → actual delivery → verification → final login/change password/bind, only have your own authorized number/email.

## Method
1. Normal low-frequency confirmation of true arrival, success/queue acceptance/caching is not delivery.
2. CAPTCHA/frequency constraint comparison proves legality, error, and missingness; records the actual delivery of normal restrictions and variants. A small amount of 429 does not infer unlimited expansion/tariff loss.
3. Verification code/link bound account/purpose/session/device/expiration, own A/B and error/empty/missing/used values ​​are compared one by one, and finally check the status of private resources or own credentials.
4. Magic Link's token/pin/address/validity period is verified in stages; obtaining a link or PIN match does not equal a complete login, and reissuance is separated from replaying after use.
5. When the Host/server URL structure changes the link, its own inbox checks the actual address; reflection, front-end splicing, and email template are attributed separately. Header injection is for controlled recipients only, checking the real headers/body.

## Conclusion
Enumeration, delivery constraints, replay, and authentication bypass are recorded separately; sending issues are not forced to be escalated and taken over, and messages are not sent to unfamiliar subjects or consumed on a large scale.
