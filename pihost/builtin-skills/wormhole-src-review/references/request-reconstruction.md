# JS request and signature restoration

Normal XHR → Initiate code → baseURL/routing → Request interceptor → Signing/encoding → Send layer-by-layer positioning. Search dynamic chunk/source map, Authorization/token, sign/salt/publicKey, nonce/timestamp, hide management entrance, and retain the difference between dead code and real calls.

Record parameter sorting, JSON blank/null value, byte encoding, URL encoding, time unit, nonce, fixed salt/dynamic key source; first run the existing function on the normal page to generate your own object request, then reproduce it locally and check it byte by byte. To understand the ciphertext ID generation process first, re-encode it with your own ID instead of randomly changing the ciphertext.

Normal signature, wrong signature, legal but non-existent object as three groups. Object permissions/query semantics can only be tested after obtaining a valid business response; signature rejection does not mean that business permissions are secure. The public key/anonymous key is not directly considered a secret. New domains/accounts/keys are only used as clues and do not automatically expand permissions or store clear text records.
