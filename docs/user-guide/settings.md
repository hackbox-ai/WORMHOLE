# System configuration

## Operation and task budget

Context compression is used to organize long conversations, and the compression records are saved in the task working directory. The default compression method is used when experimental compression is turned off.

The number of Workers affects the execution concurrency of new tasks. Planning constraints and execution constraints are handed over to Planner and Worker respectively, and take effect according to subsequent operations or planning.

Fill in the upper limit of the task budget with 0 to indicate no additional restrictions; after reaching the budget, it will be paused and the evidence will be retained, and you will continue to obtain a new round of quota manually. Task deadlines and Agent running limits are still valid independently.

Progress judgment is based on new evidence and coverage, and does not use the number of vulnerabilities as the only criterion. It takes about 30 seconds for the running task to read the new budget value, and the paused task will not be automatically resumed.

The batch default timeout starts from the actual start time and can be adjusted when creating the batch; queue waiting is not included in the task duration.

## Traffic and proxy

Traffic capture, automatic correlation evidence, regular exit, model agent and search agent are configured separately. The springboard channel only takes over the corresponding target traffic.

[Traffic Description](/help/?topic=traffic) · [Springboard Channel](/help/?topic=network)

## Search

After enabling network search, authorize the corresponding capabilities in the Agent. Configure the necessary keys and search proxies by source, and use the Test button to check the currently entered source, authentication, and proxy.

DeepSeek search requires the current LLM to use the official model and Anthropic protocol that supports this capability, and use the LLM agent, which may incur model calling fees. Other sources are accessed per search agent configuration.

## Local preferences and interpreters

The message sending method is only saved in the current browser. The Python interpreter is used for scripting tools. Leave it blank to automatically detect it, or you can specify it explicitly and detect it.

## Update and rollback

Updates and rollbacks will restart the service and may interrupt running tasks. Please check the page to confirm before operating. Application updates in container mode do not include the container tool chain, and changes in the tool chain require an image update.
