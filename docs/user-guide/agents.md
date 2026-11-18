# Agent

## Create a new custom Agent

Select New on the Agent page, fill in the Key, name and description, and then configure the default model, running restrictions, prompt words, closing, MCP, Skill, tools and triggering strategies in the same editor.

The settings during the creation process are saved in a local draft. Click "Create Agent" to save them once. Closing or canceling a draft does not leave an empty Agent. Triggers can be added to the to-be-created list first and then created with the entire Agent. If the creation fails, the filled-in content will be retained and you can correct the errors and try again.

Key is fixed after creation; prompt word history starts recording after successful creation.

## Edit role

Open the role in the Agent list, modify the prompt words, running restrictions and ability bindings and save. Task orchestration uses roles such as main Agent, Planner, and Worker to divide labor; other Agents can also be selected for independent conversations.

Model selection and tool authorization should be configured by role usage. The default model can follow the task and global configuration, and the specified model configuration is used when explicitly bound. The interactive shell switch is used to grant persistent terminal capabilities. The specific time when the modification takes effect depends on the new session or the next run, and requests that have already been started will not be retroactively modified.

## Capability authorization

MCP, Skills, and Built-in Tools each control a character's visible abilities. Whether a tool can execute is also subject to interception rules, approvals, and task scope. After adding an MCP or Skill, check the character binding. Do not judge that it is callable just because it exists in the library.

## Running restrictions and closing

The single Agent run limit is different from the entire task deadline. Use a single ending prompt when the number of runs or time is exhausted; use a task ending prompt when the entire task is about to time out.

Closing is used to write back existing information, findings, and conclusions. Leave blank to use the built-in default. When modifying the custom prompt words, keep the evidence storage and task report requirements to avoid only outputting the summary without saving the results.

## Delete custom Agent

Custom Agents can be deleted from the right side of the list or from the bottom of the edit panel. After confirmation, prompt words, triggers, scheduling status and capability bindings will be removed, and historical conversations will be retained. If deletion fails, an error will be displayed in the confirmation box and you can try again.

The system's built-in orchestration roles are retained and do not provide deletion operations.

## Automatic trigger

Custom Agent's trigger creates a new session to run when the condition is hit. The system comes with triggering reasons and related task, discovery or target information. When troubleshooting unexpected new sessions, you should check both triggers and execution records.
