#Business invariants and state transitions

## Model
Role, attribution, state machine and invariant: The amount is determined by the server product/quantity, the coupon is limited to times/commodities, points cannot be added by the client, approval cannot be skipped, and refunds cannot exceed the actual payment. The normal complete chain and persistent ledger are used as the baseline.

## Method
1. Amount/Quantity: Special test orders are relatively normal, negative/zero/decimal/type changes, check server settlement, balance, inventory and final order; client quotation/echo does not make profit.
2. Coupon/Promotion: The self-owned test coupon is bound to another approved product, check the final pricing and server applicability, and binding 200 is not enough.
3. Status: Jump to the front, repeat the last step, rollback/out of order, check the true final status item by item, and record the actual steps that can be crossed.
4. HPP/duplicate key/array first identifies the first/last/array semantics, and checks the effect of the gateway check value being inconsistent with the back-end usage value.
5. Public catalogs/prices/lists that can be registered are judged based on openness; multiple rows of data do not automatically equal private leaks, and unpublished/paid/other subject data will be matrixed separately.

When sharing resources across steps, batches, splits/merges, and multiple entries, press [Process and Status Analysis] (${SKILL_DIR}/references/workflow-analysis.md) to check the cumulative window and conservation relationship; the normal complete process and final ledger take precedence over the echo of a single request. Use the offline tools when you need auxiliary calculations, and the results are still associated with real evidence and written back.

## Constraints
Funds/tickets/inventory/approvals can only restore dedicated objects and permissions. There is no permission to stop blocking, unreal payment or repeated consumption; concurrent read race method, no need to sustain high load proof.
