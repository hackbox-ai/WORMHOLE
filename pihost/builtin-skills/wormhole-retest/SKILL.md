---
name: wormhole-retest
description: Perform targeted repair verification based on existing vulnerabilities, original evidence and current constraints, save reproduced/fixed/inconclusive conclusions, and do not regard environmental failures as successful repairs.
---

# Vulnerability retest

First call get_finding_retest_context to read the original vulnerability evidence, snapshot and current constraints associated with this session. Only retest the vulnerability and necessary adjacent variants, using current actual tools and identities, without reusing expired credentials assumed to be valid.

1. Establish a legal baseline to prove that services, accounts and business objects are still normal.
2. Perform the minimum verification of the original PoC under the same preconditions, and save the real difference before and after; when the original experiment has side effects, it is subject to the current constraints and approvals and will not be repeated automatically.
3. The same vulnerability selects adjacent variants according to the mechanism: object unauthorized review of the same business details/attachments/exports and A/B attribution; path filtering review of legal methods/request bodies and original valid standardized variants; authentication review challenge and account/purpose/session binding; SSRF separately checks DNS/HTTP/echo; stored XSS is reviewed by the original writer and another test viewer. Only the objects and entrances within the range are measured, not all of them are arranged.
4. For repairs such as path filtering and tenant switching, only relevant variants within the authorization scope are verified; deactivation of a tenant does not mean global code repair, and untested tenants are listed as restrictions. Check whether the recorded version and switches remain the same as the original PoC.
5. 200 + HTML, 404, invalid identity, function offline, current limit or illegal request body cannot be independently proven fixed. Select inconclusive when valid verification with the same conditions cannot be established.
6. Only use actual evidence to determine reproduced / fixed / inconclusive, call record_finding_retest_result(verdict, summary, evidence). It doesn’t say it’s completed if it’s not saved successfully.

Summary writes the conclusion, and evidence writes the legal baseline, actual verification, negative comparison, real references and limitations. The body does not expose full credentials. Retests are independent conclusions and do not overwrite original evidence or create duplicate findings; vulnerability status changes are handled by the platform. Cancellation/timeout received stops new requests and states validated scope.
