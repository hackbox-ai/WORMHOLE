# Traffic and Evidence

## Enable capture

The traffic capture switch in the system configuration controls logging capabilities. When enabled, it provides the agent with recording agent and traffic query capabilities; when disabled, the corresponding recording is stopped, and the springboard task retains its bound channel.

The capture range is based on the actual recorded link request. Standalone tools, processes that do not use a proxy, or protocols that are not proxy-compatible may not be documented.

## Query request and response

Filter by task, host and other conditions on the traffic page to view the request header, body, response and status. When there is no record, first confirm that the task has indeed sent a packet, and then check the capture switch, proxy usage, filter conditions and network channels.

## Associated vulnerability evidence

After selecting the request and response, bind it to an existing vulnerability, explain how it supports the conclusion, and distinguish between normal controls, vulnerability proof, and supplementary verification. The order can be adjusted after binding.

Automatic association is controlled by configuration and may increase model consumption; findings can still be reported when there is no matching traffic. Turning off automatic correlation does not affect manual binding and saved evidence.
