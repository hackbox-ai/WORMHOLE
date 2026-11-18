# Batch assignment and field-level permissions

## Prefix
Capture the legal creation/modification request of the low-privilege subject, and identify the role/isAdmin/verified/ownerId/tenantId/price/status that the server should manage from the schema/management end/response; the presence of the field does not mean that it is received or applied.

## Experiment
1. Save the original state and normal modification results of your own objects. Adding one additional field at a time leaves the other parts unchanged.
2. Compare nested objects, array items, null, strings/numeric values ​​according to the actual parser, without blindly adding the entire set of admin fields.
3. Re-GET the persistent object after the response; permission changes are verified by new sessions and protected operations, and the same request echo is not verified.
4. Owner/tenant changes use A/B authorization test objects to check ownership and visibility of both parties; check item-by-item results and transaction behavior when batch operations include allow/deny items.
5. Keep candidates when there is no write permission or cannot be restored, and record the request shape and missing certificates.

## Criterion
Fields that are ignored, normalized, or have only free metadata do not amount to an escalation of privilege. Being able to change the display name does not infer that the role can be changed; it must be proven that the server-side invariant has changed. After the experiment, restore your own objects and review them.
