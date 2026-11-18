# Springboard network mode

Configuration → System Settings → Network Access Mode. Select regular mode or springboard agent mode; the default settings are for new tasks only. Channels can be selected for both single tasks and batch tasks, and the channel, version, and parent chain are fixed after creation. Existing tasks will not change their exits with the default configuration.

## Channel and multi-level access

When adding a new channel, fill in the name, access address and accessible domain name/IP/CIDR, one item per line.

- Direct access to WORMHOLE: For the access address, fill in the WORMHOLE server address that is accessible to the on-site machine.
- Access via the upper-level channel: First set the "lower-level access monitoring" in the upper-level channel, and then select the upper level; fill in the access address of the upper-level machine that can be accessed by the deep machine. The port is taken from the superior monitoring port.
- Lower-level access monitoring: Optional, fill in the on-site local machine IP: port; only leave it blank when the leaf springboard accesses the target.
- Full Network: Enables TCP, UDP, ICMP and raw messaging tools, requires administrator privileges. HTTP/HTTPS and proxy-compliant clients are still supported when turned off.

For example, WORMHOLE ← Site A ← Deep B: A directly accesses WORMHOLE and monitors 192.168.10.5:18888; B selects A and fills in the access address 192.168.10.5. The two machines run the connection packages they downloaded respectively. B's target request is issued by B, and A is responsible for relaying B's connection. Supports up to 8 levels and 8 enabled channels; channels support editing. The name and target test address take effect immediately; modifying parameters such as connection address, range, superior relationship or complete network will generate a new configuration version, which requires re-downloading and restarting the affected channel and downstream connectors. Modifying the upper-level listener will synchronize the lower-level port; when the lower-level access address is consistent with the old monitor, it will be updated, and the custom DNS/NAT address will be retained. It is prohibited to modify the connection parameters of the channel chain used by unfinished tasks. Historical tasks retain the original version snapshot and do not automatically swap ports. Deactivating any superior blocks the entire chain of subordinates.

The task list displays springboard identification, and details display channel status and multi-level paths. Online indicates that the proxy handshake is successful; "Layer 3 network ready" indicates that the complete network service is not ready. Click "Check Connection" to check the entire channel and complete network status. There is no need to fill in the IP, and the target service will not be accessed. "Target access" is an optional additional check that automatically brings out the saved test address or the target in the same channel task; after clicking, a non-redirected GET is sent to avoid filling in interfaces with side effects.

## Installation

Run pihost/scripts/install-network-runtime.sh on server Linux; or use WORMHOLE_FRP_DIR to point to the deployed directory. Linux link packages are built with CGO_ENABLED=0 to avoid relying on the build machine's glibc version. Older kernels can be used for channels that only carry upstream relays; full network egress must still meet kernel requirements such as SO_NETNS_COOKIE. frp is fixed in 0.72.0, and the connector dependency is fixed by network-runtime/go.mod, go.sum. Windows Wintun 0.14.1 is downloaded from the official site and SHA-256 verified, and the connection package comes with its distribution license.

Server-side command isolation requires root, unshare, mount, ip, setpriv, python3, and /dev/net/tun. On-site Linux full network connector requires root, ip, iptables, ip6tables, TUN, and kernel SO_NETNS_COOKIE support; on-site Windows requires administrator privileges, WinNAT, and the official wintun.dll in the same directory. If Windows already has other WinNAT, its configuration will not be overwritten and must be integrated by the administrator. Linux provides IPv4/IPv6 NAT; Windows WinNAT provides IPv4 by default, and IPv6 will not silently switch to direct connection.

After downloading the connection package, enter the decompression directory:

Linux：
chmod 600 connector.json frpc.toml
chmod +x wormhole-connector frpc
sudo ./wormhole-connector -config connector.json

Windows administrator terminal:
.\wormhole-connector.exe -config connector.json

A non-zero exit code is returned when the connector fails to start or frpc exits unexpectedly; active stopping recycles the child process and exits normally. The newly downloaded connection package will be retried when the server is not ready or the link is temporarily interrupted. It will be reconnected after the service is restored and the test request will not be automatically replayed. Old packages need to be re-downloaded to obtain new startup and retry configurations. The server will resume the forwarding child process that exited unexpectedly; actively deactivating the channel and closing the service will not trigger automatic pull-up.

The connector is responsible for starting frpc, carrying Layer 3 messages, and optional lower relays; do not just run frpc, otherwise the complete network and lower relays will not be ready. Closing a connector closes its session, TUN, and rules created this time; forwarding settings are restored as per the connector reference count. The connection contains confidential configuration and may not be shared publicly. The TUN internal IPv4 address pool is 198.18.0.0/15, and customer networks should avoid overlapping with this transport address pool.

WORMHOLE access HTTP CONNECT that reuses the original application port, without additional exposed SOCKS/control port. The WORMHOLE front reverse proxy must allow CONNECT, or give the site direct access to the WORMHOLE access port. The relay only accepts CONNECT with credentials and a fixed connection to the configured upper-level access point, and does not provide web page or arbitrary destination forwarding. Each level has independent access credentials; the inner layer of frp enforces TLS and verifies the identity of the CA and fixed server in the package.

## Task execution

- http_request, browser, modeling, fingerprinting, and JS adapter use task HTTP/MITM routing, preserving task, inspection, and request associations. Closing the collection still goes through the springboard.
- Bash, PTY, custom Python/commands, local stdio MCP into independent mount/network/PID namespace. Full networking provides TUN, on-site DNS, and default routing; scanners are not required to follow HTTP proxies. The original SYN, TCP connection, UDP, and ICMP are actually sent by the on-site kernel, and the SYN scan is not rewritten into TCP connect.
- The subcommand only retains the NET_RAW of the namespace, and cannot manage routing, switch back to the host network, or access the host service socket; writable files are limited to the current working directory. Uninstalled MCP programs should be installed in advance and configured with absolute path entries and dependencies; the host npm cache will not be borrowed during isolation.
- HTTP/SSE MCP's access communication passes through the task proxy, and the remote MCP should be deployed within the allowed range. The internal behavior of the remote MCP tool is implemented by its server; WORMHOLE's local namespace does not constrain the execution environment of the remote server itself.
- JS uses adapter mode in reverse: the adapter executes in an isolated process, sends ciphertext through task MITM, returns plaintext, and records wire/plaintext respectively; rejects the legacy spontaneous packet mode to bypass the association.
- Original TCP/UDP/ICMP acquisition records are not converted to HTTP through layer 3 channels; scan results, tool audits and local evidence are still retained. Model, search, and platform communications maintain separate exports.

The server and the on-site connector bidirectionally verify the source/destination address; the domain name is resolved on-site, and the address of the approved session is fixed during the session to avoid DNS cache expiration interrupting existing connections. Task stopping, pausing, parent task ending, or channel deactivation denies new access and closes existing connections. When offline, there is no fallback and direct connection. Requests with side effects are not automatically replayed. The original task time limit continues to run; local evidence and reports are still allowed to be saved.

## Verify

Using an isolated test database:
WORMHOLE_NETWORK_INTEGRATION=1 node --import tsx --test tests/network-full.test.ts

The test creates independent sites and target network namespaces. Deep sites can only access WORMHOLE through upper-level relays; the target has no default return route to truly verify on-site forwarding and NAT. Covers double hop, co-located task isolation, on-site DNS, TCP/UDP, IPv4/IPv6 ICMP, Nmap connect/SYN, reachable negative lookup for range interception, local and HTTP MCP, AES/HMAC adapter and ciphertext/plaintext collection, credential rejection, superior deactivation, in-progress task stop and remote resource recycling.

tests/network-mode.test.ts verifies the original proxy mode, browser login, collection switch, modeling inheritance, etc. Windows connector cross-compilation, driver distribution package verification, and script static inspection are not equivalent to Windows on-site acceptance. Two-level cross-machine acceptance has been completed for the Linux/IPv4 link at 176 → 138 → 177 → 125; it is not claimed that the Windows real machine, cross-machine IPv6 or the customer's actual network has been accepted based on this.

Connector lifecycle regression: WORMHOLE_NETWORK_RECOVERY=1 node --import tsx --test tests/network-recovery.test.ts. Use an isolated test database to cover late service startup, frps failure recovery, deactivation/recovery, and non-resurrection after shutdown; network-runtime's go test covers exit codes, child process recycling, and startup failure cleanup.
