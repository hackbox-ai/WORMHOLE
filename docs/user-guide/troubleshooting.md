# FAQ

## No feedback after task startup

Check whether the task is queued, paused, or awaiting approval, and then view the task dialogue, real-time updates, and Trace. Business modeling runs in the background and its status should be viewed separately. Record the specific tasks and the last event time to avoid judging task failure based only on the time spent on the page.

## Model connection failed

Check Base URL, protocol, model name, key, and model agent. 401 or 403 checks the authentication first, 404 checks the address and model, 429 checks the quota and current limit, and 413 checks the context. Handle errors according to actual service.

[Retry and Failover](/help/?topic=llm-retry)

## No traffic

Verify that the request was actually executed, checking capture switches, logging agents, task channels, tool agent support, and current filtering. The browser screen or tool text alone cannot prove that the traffic has been included in the database.

## No fingerprint or PoC results

First confirm that the task has obtained the response or page material, and then check the automatic identification, rule status and product matching conditions. No fingerprints does not mean no product, and no candidates does not mean no vulnerabilities.

## The springboard is online but the target is unreachable

The fact that the connector is online only indicates that the connection is established. Check routing, firewalls, service ports, authentication and operating permissions for each hop, and confirm that the task has been bound to the correct channel.

## Report or missing link

Check whether the findings have been stored in the database, whether the exploration nodes and evidence are associated, and whether the report has been generated or needs to be updated. When historical data lacks correlation, evidence cannot be supplemented by color or page switching alone.
