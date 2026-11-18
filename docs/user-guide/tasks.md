# Dialogue and Quests

## Initiate task

Create a new task on the task page and fill in the goal, description and test scope; you can also describe the requirements to Auto in the conversation, and it will dispatch the task based on the context. Run records of independent conversations and formal tasks should be viewed as per the actual session to which they belong.

Provide access, identities, and restrictions to clarify which targets allow testing. Saving a template allows you to reuse descriptions, goals, categories, and task-level rules; applying a template is a copy and will not be continuously synchronized with the template.

## Batch tasks

Bulk portals identify targets one domain name, IP, or URL per line, up to a maximum of 500. Each target saves tasks, findings, links and reports independently.

Ordinary tasks and infiltration dialogues in execution share the global quota, and a maximum of 3 tasks can be run at the same time. After completion, the tasks will be filled in the queue. Batch tasks do not require a fixed number of vulnerabilities. They should continue to cover executable directions and end when there are no executable directions or the deadline is reached.

The timeout is timed from the actual start, and the queue is not timed. The task time limit of each target and the running limit of a single Worker take effect separately.

## Execution process

After the task is started, you can view the main Agent, Planner, Worker and system events in the task dialog, and view the exploration relationship in the execution path. Business modeling is performed in the background, and the modeling status and test progress can be viewed separately.

The main Agent receives user supplements, the Planner organizes the exploration direction, and the Worker performs verification and evidence recording. Whether the newly added information forms a follow-up task shall be subject to actual planning, tools and write-back records.

## Advanced parameters

Each line of the target system entry contains one item for browser and background modeling; if left blank, identify it from the task target and description.

Direct execution will hand the description and goal to the Worker as the first intent, and then the Planner will take over. When closed, plan first and then execute.

The planning interval is used to wake up planning when there is no trigger for a long time, with a lower limit of 10 minutes. Coverage switches determine the use of scope tools, progress, and coverage statistics.

Related tasks provide a read-only context for the directly related task. The task itself continues to be written to the independent blackboard, and the association should not be understood as copying or continuing to run the old task.

## Pause, stop and timeout

Pause is used to temporarily stop scheduling and execution, and can be resumed later. Stopping cancels running workers and browser operations and saves existing findings and reports.

When the task is close to the deadline, it should be concluded and the results should be saved based on existing evidence. Timeout does not mean that no discovery has been made. Check existing vulnerabilities, execution records and reports after the end.

Modifying the target may trigger re-planning or restoration of the final task; the page will retain corresponding operation prompts.

## Classification and archiving

Classification is used for filtering and sorting and does not affect Agent execution. Archiving compresses execution-related data to cold storage, which can be restored from archived pages. Archiving, deletion and file cleaning have different impacts. Check the range in the confirmation box before execution.
