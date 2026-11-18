# Model configuration

## Create new model configuration

1. Select New on the LLM page and fill in the name, protocol, model and connection information.
2. Fill in the Base URL and API Key as required by the supplier; refresh the button to try to obtain available models.
3. Click Test Connection to check the address, protocol and key based on the actual returned results.
4. Click New to save; return to the list to activate the configuration that needs to be used as the default value.

The model name should be consistent with the name actually provided by the server. A successful test connection indicates that the test request was successful. Complex tool calls and long contexts still need to be checked in conjunction with task performance.

When editing a key, leave it blank to retain the existing key. Saving configuration and activating configuration are two operations. Changes to an activation configuration may affect subsequent requests to use it.

## Proxy and session header

The request proxy only acts on model requests, leave it blank for direct connection, and supports HTTP, HTTPS, and SOCKS5. Special characters in proxy authentication should be URL encoded. The model agent, search agent, target exit and springboard channel are configured separately.

Customize the session header to fill in the request header name; the platform will use the current session ID as the value. Leave blank and do not send. It can be used for gateway caching or session routing. Do not fill in the key or full request header in the header name.

## Speed limit and context

The rate limits per second and per minute are shared among Agents using this configuration, 0 means no limit.

The context window unit is K, which is one thousand tokens; 0 uses the default 200K and the maximum is 1000K. Should be set according to the true window of the model, false height will delay compression and cause context overruns.

The output upper limit is the token upper limit of a single response, 0 uses the server default. Output that is too small may truncate reasoning, answers, or tool parameters.

## Streaming response and output fields

Streaming response is enabled by default and is used to receive incremental content and running progress. After closing, send a non-streaming request and wait for the server to return a complete response. If the SSE of some gateways is incompatible, you can try to close it and re-verify the connection and tasks.

The OpenAI protocol can optionally output an upper limit field, set according to the max_tokens or max_completion_tokens actually supported by the interface. The Anthropic protocol uses max_tokens permanently.

## Thinking and reasoning intensity

Thinking mode and reasoning strength are two independent parameters.

- Do not send thinking mode: does not carry the thinking field, applicable to interfaces that do not support this field.
- Off: Send disabled.
- On: Send enabled.
- Reasoning strength: Independently mapped to protocol supported reasoning_effort or output_config.effort.

Different models have different parameter support ranges. When encountering parameter rejection, first set the unsupported fields to not be sent, and then test. Don't compensate for address or protocol errors by increasing the strength.

## Priority and failover

The active configuration takes priority; the larger the numerical priority of the standby configuration, the higher it is, and the same priority will rotate. Whether the actual switchover occurs is also subject to rules such as the explicitly specified configuration of the failover switch, Agent or task.

Configurations that do not participate in polling can still be explicitly specified by Agents or tasks, but will not enter the automatic standby chain. Suitable for configurations that require separate allocation.

[Full retry and failover instructions](/help/?topic=llm-retry)
