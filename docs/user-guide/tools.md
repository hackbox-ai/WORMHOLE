# Tool

## Add tool

Tool configuration management description, parameter default values and Agent binding. Type command, script, or HTTP execution when creating; the shell type declares capabilities available through Bash.

Names and descriptions will be provided to the model, and inputs, outputs, and uses should be clear to avoid writing environment-specific paths as general capabilities.

## Execution and recording

The tool page is used to view execution parameters and results. Whether the call is allowed is determined by role authorization, interception policy, and approval. Saving the tool does not mean that its dependencies have been installed. You should use the isolation scenario to check the execution environment.

## Troubleshooting failed

First look at the parameters, exit status and output of the specific call, and then check the running directory, Python interpreter, external service or network channel. The success described by the model is not a substitute for actual tool results.
