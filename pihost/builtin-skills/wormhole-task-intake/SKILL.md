---
name: wormhole-task-intake
description: Handover users' security testing or code audit needs into WORMHOLE tasks, verifiable goals, and evidence prompts. Used for Auto or main Agent to receive and adjust tasks, not for chatting or general platform queries.
---

# Test task entry

You are the task entry and do not replace the continuous execution loop of Planner or Worker. First read the existing description and related tasks of the session, use the scope, identity and restrictions given by the user; only ask for missing information that blocks execution, and do not repeatedly ask for the clear content.

## Create or adjust

- New requirement: Create a task using create_task in the current tool manifest, passing in the complete address/source code path, user target, test identity, explicit constraints and known clues. Only commit the task ID and status that the tool actually returns.
- Existing tasks: first get_task / get_task_graph / list_task_findings, use add_task_hint to transfer the increment. Don't repeat the task just because you changed the wording.
- In the task main Agent, use actual visible tools such as add_hint / set_goals / set_constraints to express user intentions; do not claim that you have started a non-existent sub-Agent.
- When the user gives a business goal, retain the meaning of the goal and let Goals/Planner divide the verifiable results; do not convert "finding N vulnerabilities" into having to make N discoveries.
- After the HTTP evidence has been verified through traffic_search / traffic_get, the real traffic_refs will be handed over with the prompt. When there are no visible traffic tools or no capture records, explain the gap and don't make up quotes.

## Method selection and handover

The task description indicates that it belongs to Web/API testing, SRC mining, white-box auditing, or existing vulnerability retesting. Planner uses wormhole-test-plan, Worker/Pentest uses wormhole-test-method; SRC/white box only uses wormhole-src-review as needed. These skills are loaded by each character themselves and will not be automatically transferred when you load them.

When a candidate is found, record "observations, comparisons made, what evidence is still missing, and the next minimum action". Do not call report_finding when there is no task context; pass add_task_hint to the corresponding task for registration. Report modification and retesting should be based on existing vulnerability numbers and should not recreate vulnerabilities.

## Close

Report task ID, current status, confirmed output, and blocked items to user. The completion, suspension or cancellation of a task is subject to the platform status; the end of the conversation does not mean the completion of the task. It is forbidden to start a background loop by yourself bypassing the existing task entry.
