# Retry and failover

## Configuration range

The LLM page's retry and backoff settings manage global defaults. A single model can cover three layers: connection establishment, empty response and streaming security window; circuit breakers and intent reruns are set globally.

Leave the number blank or fill in 0 to use the default value; fill in -1 to close the corresponding layer, and use the specified number for positive numbers. Leave the interval blank or fill it with 0 to use the default policy, and a positive number to use a fixed millisecond interval. Different layers may be superimposed, and higher times will increase waiting and model consumption.

## Retry establishing connection

Handle connection resets, network timeouts, DNS failures, and HTTP 408, 429, 500, 502, 503, 504 before the response is established and resend the request unchanged. The default number is 3, initial 0.5 seconds, exponential backoff, upper limit 8 seconds.

Deterministic errors such as 400, 401, 403, 404, 413, 422 etc. should check parameters, authentication, model and context. Exceptions after the response flow has started are handled by other layers.

## Empty response retry

Only for OpenAI protocol: HTTP 200 and normal stop, but retry when the entire response has no content block. The default number is 2, initial 0.5 seconds, exponential backoff, upper limit 8 seconds.

The output upper limit should be adjusted when there is no content due to output upper limit truncation. Empty response retry will resend the entire context a controlled number of times.

## Streaming security window

Connection dropped, overloaded, or in-stream 429, 5xx retry on the same configuration when the stream has been established but no output has yet been delivered to the caller. The default number is 2, initial 0.5 seconds, exponential backoff, upper limit 4 seconds.

Insufficient credits, too long contexts, and deterministic parameters or authentication errors are not handled by this layer. You cannot use this layer to directly replay output after it has been delivered to avoid repeated output or execution.

## Fusing and cooling

After the instantaneous failure accumulation reaches the threshold, it enters cooling; if it succeeds, the accumulation will be cleared. Deterministic errors such as authentication, quota, and model non-existence can directly trigger the circuit breaker. The cooling configuration is skipped during polling, and the cooling and failure status can be viewed on the page.

Default instantaneous failure threshold is 3, with cooldown in increments of 1, 5, and 30 minutes. Fill in -1 to turn off the instantaneous failure threshold circuit breaker, and deterministic failure may still cause circuit breaker failure.

## Intention to rerun

When the Worker ends due to a model error and the inner layer retry does not recover, the intent can be re-executed. The default number of reruns is 2, with an interval of 3 seconds. Fill in -1 to close.

Pause, terminate, and task completion interrupt this type of waiting. Intention to rerun will re-enter the internal retry process, and the number of each level should not be set to high at the same time.

## Automatic failover

Whether the Agent of the unspecified model switches from the active configuration to the standby chain is controlled by the polling switch. Explicitly specifying whether the configuration allows rollback is controlled by an independent switch; the specified relationship is retained when turned off by default.

Task explicit configuration chains are used in the selected order and have their own quota switching conditions. Do not understand global polling, retry and task configuration chain as the same switch. Configurations whose context window is not large enough to accommodate the current request will be skipped. Actual order, cooling and errors are subject to page status and Trace.
