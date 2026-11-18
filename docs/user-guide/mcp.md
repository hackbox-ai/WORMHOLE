# MCP

## Connection service

Create a new connection in MCP, fill in the connection method, address and authentication information supported by the service, and refresh the tool list after saving. After the connection configuration is successful, the required Agent needs to be authorized.

When no tool is found, check service reachability, authentication and tool return first, and then refresh. The connection and tool status displayed on the page can better indicate whether the access is completed than simply saving successfully.

## Authorization and calling

Agent can only use services and tools visible to it. A Skill can also be associated with an MCP, which exposes related capabilities when the Skill is loaded. The call still goes through the platform execution and interception link.

## Modify and delete

Recheck the tool list after modifying the connection. Deleting a service will remove the connection and related Agent authorization; confirm whether the role is still used before executing.
