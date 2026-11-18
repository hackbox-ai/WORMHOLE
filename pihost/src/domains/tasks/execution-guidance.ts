/** Runtime policy is appended after editable role prose so old templates do
 * not require overwriting the operator's saved prompts. */
export const goalEfficiencyGuidance=`
[Goals and Delivery Rules]
When the user requests to test/check a certain type of vulnerability, the final deliverable is a test conclusion with evidence, allowing positive, negative or insufficient conditions; it is not allowed to change "check" to "at least one vulnerability found" without authorization. This type of goal sets objective_type=coverage.
Set objective_type=finding only if the user explicitly requests vulnerability verification. Failure to discover or lack of credentials does not mean that the goal has been achieved, and false reporting of met is not allowed; keep the unachieved status and explain the reasons.`;
export const plannerEfficiencyGuidance=`
[Execution efficiency rules]
Reuse already recorded negative results. The intent requires a verifiable hypothesis and stop condition; provide test_key (concrete object + method + hypothesis), hypothesis, stop_condition.
If there is no new evidence in the same direction, the case cannot be reassigned with another explanation. Reopening of a completed direction must refer to the new_evidence_ids of this task that were added after its completion; the existing failed results themselves are not new evidence.
For goals that have been tested but not discovered, use resolve_goal(outcome=tested_negative) to reference the negative fact with evidence; when credentials/entrances/environments are missing, use resolve_goal(outcome=blocked) to reference the conditional gap fact. This only records the conclusion of the exploration and does not claim that the vulnerability has been confirmed.
Do not continue to blindly guess or repeat closed paths to satisfy the vulnerability category list.`;


export const plannerReverseGuidance=`
[Encryption interface] How to handle it is up to the worker to decide. Do not derive a separate "reverse intention" for it.
- Optional paths include: reading the source code directly, evaluating in the browser, writing a script to calculate locally, using REA, or making a platform-hosted encryption and decryption proxy (start_reverse_proxy). No one is a must, and don't specify which one he must use.
- reverse_proxies is the list of proxies that are actually running for this task. When planning a new direction: There is already a running agent on an interface → Write in the summary "There is already an agenthttp://127.0.0.1:port and you can directly create a message" to avoid duplication of work; do not send multiple directions to the same interface.
- [REVERSE_READY] fact appears → The interface is available, and subsequent directions can be further explored (parameters, override, injection, batch).
- [REVERSE_UNUSABLE] appears and there is no updated [REVERSE_READY] → This path is temporarily unavailable; you can change the direction of the idea (another entrance, another set of credentials, the browser side), but do not let him retry the same algorithm as it is.
- The time spent on this type of work is counted in the worker's own round. When budget is tight, give priority to "intensive utilization of already available interfaces".
`;
