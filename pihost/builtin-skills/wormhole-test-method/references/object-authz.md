# Object and tenant authorization matrix

## Prepare
Use two authorized test subjects A/B, each with OA/OB that can prove ownership, and a random non-existent object OX. Record roles, tenants, publicity and allowed operations; tenant administrators are not platform administrators, and public objects cannot prove private read unauthorized access.

## Minimum matrix
| Subject | Object | Purpose |
| --- | --- | --- |
| A | OA | Normal business baseline |
| B | OB | Second subject validity |
| A | OB | Horizontal Object/Tenant Isolation |
| B | OA | Reverse Authentication (Budget Allowing) |
| Anonymous/Low Privilege | OA | Identity/Vertical Privilege |
| A | OX | No object negative control exists |

## Execute
1. First use profile/me or your own resources to prove the current identity to prevent cookies from overwriting the token. Changing only one ID/identity at a time, checking path/query/body/header/cookie where it actually exists.
2. Check lists, details, attachments/previews, downloads/exports for the same object respectively; parent object verification does not mean that the child resources are safe.
3. Only B's special recoverable object is allowed to be modified during write verification, and B's independent re-reading and confirmation; 200/field echo does not equal permanent modification. Writing is not allowed and the gap is recorded.
4. Filtering, paging, batch ID, nested association, different role entries and private fields are covered one by one, not just keyword or single GET.
5. When there are missing clues for filtering, compare the tenantId default/null/0/-1 semantics under the own canary, and do not expand real user enumeration or full database export. The encrypted object first establishes legal encoding/signature, and keeps the method, CSRF, and request body valid.

## Criterion
Supported only after A reads the OB independent private mark, or B confirms that persistent modification is not authorized and the normal/non-existent comparison is established. Excludes public content, shared objects, template wrappers, cache wrappers, and individual total changes. Declare tested roles/tenants/operations, do not infer the entire platform from one object.

The difference between 403 and 404 can only prove the difference in response, but cannot independently prove that OB exists, belongs to B or has been verified in the authorization layer; there must be evidence of legal access/independent ownership of B. The owner field in the response cannot replace the current actor identity verification. When the B identity/ownership is missing, the matrix row BLOCKED is recorded, and the conclusion is limited to "the current request does not cross the boundary". It does not claim that the object isolation is fully correct or that the enumeration has been confirmed.
