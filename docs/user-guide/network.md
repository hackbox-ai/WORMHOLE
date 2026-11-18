# Springboard Channel

## Select network mode

Regular mode uses the server to reach the network and regular exits. The springboard mode provides a path forwarded through the connector for targets that cannot be directly accessed by the server. Tasks need to be bound to specific channels.

Target traffic uses task channels; models and searches use separate exits. Existing tasks will retain their original channels, and new settings will not automatically change the binding of historical tasks.

## Configuration and deployment

1. Create a channel in the system configuration and fill in the connection and routing information according to the actual network.
2. Download the connection package corresponding to the channel, deploy the connector on the selected transit machine and start it.
3. Check the connector online status, channel connectivity, and target service reachability.
4. When creating a new task, select the springboard mode and the channel, and then start testing.

Authentication information in connection packages is managed by deployment credentials. When network capabilities such as TCP, UDP, and ICMP are required, use administrator privileges as required by the connector.

## Multi-hop example

```text
WORMHOLE server → first transit → second transit → target service
```

Each hop needs to meet the connection requirements of adjacent nodes and the target route. During verification, limit the direct path from the server to the target, and then check whether the browser, HTTP, command tools, etc. use the specified channel; simply showing that the channel is online cannot prove that all target services are reachable.

## Connectivity check

Check connectors, hops, and target services by channel configuration or test entry. Only fill in the actual destination address and port when you need to verify a specific service to avoid confusing online status with service reachability.

Checking from adjacent hops on connection failure: listening, authentication, firewall, routing, destination port and permissions. After modifying the channel, recheck the connection package and the running connector configuration.

## Docker deployment

The connector establishes authenticated CONNECT forwarding through the WORMHOLE application HTTP portal, with internal control and SOCKS ports remaining within the application container. The server address and entry port filled in on the page must be accessible from the relay; Compose uses WORMHOLE_PORT to synchronize the connection packet entry port generated. When the reverse proxy uses a different external port, set WORMHOLE_PUBLIC_PORT and verify that the proxy supports the required CONNECT forwarding.

Springboard commands and browsers use Linux namespace, and enable compose.network.yaml to provide corresponding capabilities. The capability support of Docker Desktop and native Linux should be verified separately.

Full network mode for Linux relay requires root, available TUN, iproute2, iptables, and ip6tables. When the connector exits, it restores its forwarding status and firewall resources; the normal proxy mode and the complete network mode are configured separately.
