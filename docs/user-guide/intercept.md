# Interception and Approval

## Tool rules

Tool rules are matched from high to low priority, and the first hit takes effect. Actions include allow, manual approval, and deny. Only tools with interception enabled enter the corresponding rule chain, and the specific policy is subject to the current configuration.

Rules, model review, and default policies each affect the final result. Don’t assume that users will be asked for every execution just because the platform supports approval.

## Model review and manual approval

The model review combines the prompt words and available context to give a judgment; it is configured to be transferred to manual time and is pending approval. The approval page is used to view request, basis and execution information.

Historical snapshots may be limited or truncated, and the page displays these states. Unsaved context cannot be extrapolated from the current data to the complete record at that time.

## Asset Rules

Congruent or fuzzy matching of domain name, IP, URL, and CIDR can be used. The actual interception range is subject to the currently enabled rules.

Task level rules are not written globally. Match prohibition rules (including global) first; when prohibition is not hit and there is a task permission rule, the permission rule must be hit before testing. This whitelist is not enabled when task permission rules are not configured.

## Regularity and verification

Some server-side regular extensions cannot be previewed in the browser and should be processed according to the server-side verification results. After modifying the rules, use the isolation scenario to confirm the hit, approval or rejection results, instead of directly replacing the verification with the regular save success.
