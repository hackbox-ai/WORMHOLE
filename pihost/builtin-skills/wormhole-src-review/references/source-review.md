# White box audit and variant analysis

## Build model

Confirm the code version, running entry and configuration: where does the user input enter, how is the identity established, where is the object ownership verified, and how does the data flow into storage or downstream services. List cross-tenant, process, permission and trust boundaries.

## Select a face

Prioritize the entrance that can be reached by untrusted input, historical security repair adjacent code, new interfaces and complex state transitions. Vulnerabilities cannot be deduced from function names/dangerous APIs alone.

Read [Audit Checklist](${SKILL_DIR}/references/code-checks.md) first. When there is a JS/front-end signature, read [Request Reconstruction](${SKILL_DIR}/references/request-reconstruction.md), and when there is a business interface, read [Business Candidate Selection](${SKILL_DIR}/references/business-hunting.md). Only load files related to the current stack and entry.

## Source → Sink

For each candidate record file: line number, input controllability, propagation path, encoding/filtering, permission check, dangerous operation, reachable configuration and trigger conditions. Distinguish between development environment special cases, default production paths and dependent components; mark candidates when verification is not run.

## Variants

Read the history to repair the root cause, search for other entries of the same mechanism, and compare whether consistent verification is used. Retracted patches, framework defaults, or dependency CVEs are just clues; verify the exact version and reachability conditions, and don't treat the CVE title as evidence.

## Business and status

Check object access, tenant filtering, permission annotations, serialization, template context, file path, request forwarding, race conditions and idempotence. The framework special items are selected according to the actual stack, and the entire set of knowledge irrelevant to the current project is not loaded.

## Output

Code evidence, controllable inputs, reachable premises, verified, impact boundaries, repair points and items to be verified. "Exploitable" in reports must be based on actual verification; blocking and reopening conditions are recorded when the build fails or the environment is missing. Tool execution adheres to existing approvals and task constraints.
