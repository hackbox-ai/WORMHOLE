# Templates, expressions and command execution

## Identification
Establish legal baselines for email templates, previews, export names, expression filtering, and file conversion parameters; distinguish server-side templates, client-side interpolation, shell splicing, argv calls, and business DSL.

## Verify
1. Random harmless tags confirm context/encoding, select arithmetic expression of actual stack, compare strings, valid expressions, syntax errors.
2. Check the original server response and multiple sets of inputs after correct arithmetic values, excluding client-side rendering/replacement; template evaluation is not directly equivalent to code execution.
3. The command only uses the approved harmless unique tag/read-only identity, retains the request, stdout/stderr, exit status and time; does not download the program and does not persist.
4. Blind execution must be independently controlled callbacks, excluding browsers/agents; there is no feedback to retain candidates, and no delay or model self-proclaimed execution is used as evidence.
5. EL/SpEL/XSLT selects experiments based on the real sink and running configuration, and does not apply loads that do not match the stack.

## Close
Document execution principal, location, container/sandbox boundaries, and real-world effects. The normally designed user code sandbox is not the host RCE; cross-subject/isolation effects need to be independently canary. Do not expand cloud credentials/business files without clear prerequisites.
