# Quick Start

## Complete the first test

1. Open LLM in the configuration, create a new model configuration, and fill in the protocol, model, Base URL and key.
2. Test the connection, save and return to the list to activate the configuration.
3. Fill in the test object, goals and necessary constraints in the task, or describe the requirements through dialogue.
4. View the task dialogue and execution path in the task details, and add information as needed.
5. Check the evidence in the vulnerability discovery and view the results in the task report.

Confirm target range and identity used before beginning. The target sample can use its own deployed isolated test site.

## How to describe the task

Clarify the entrance, scope, existing identity, focus direction and operational constraints. Don't ask for vulnerabilities to be reported in order to achieve volume.

```text
Test entrance:http://test.example.internal
Scope: Only this site and the same site APIs it calls.
Login: Use the logged-in test user environment in the Task Browser.
Objective: Conduct verification based on the obtained interfaces, fingerprints and PoC clues, and record reproducible evidence.
Constraints: Keep the test data and do not modify the data of other accounts; explain the steps that require manual operation first.
```

## Find function description

The Help button next to the page title opens a description of the current function. Instructions for use in the configuration popup can be read without closing the form. Instructions for use at the bottom left provide full table of contents and search.

[Model Configuration](/help/?topic=llm) · [Dialogue and Tasks](/help/?topic=tasks) · [FAQ](/help/?topic=troubleshooting)
