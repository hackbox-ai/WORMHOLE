---
name: wormhole-web-reverse
description: Analyze Web encryption and signatures in the current Worker, generate host-managed encryption and decryption adapters, and reuse real interface test links.
---

# Web reverse and encryption and decryption adaptation

The reverse belongs to the current Worker and does not create additional tasks or Subagent. Adhere to mission scope and remaining execution budget.

1. Check`reverse_proxies`first. If there is a running adapter for the same task and the same interface, reuse it.
2. If the login status is missing or ordinary permissions fail, resolve the identity conditions first and do not misjudge it as encryption.
3. Analyze JS and real messages to locate the algorithm, key source, IV, and signature fields. External tools such as REA are only used if available in the current tools list and are not assumed to be installed.
4. Write`adapter.mjs`in the intent directory and press [adapter.md](adapter.md) to export the transformation function. Don't listen to ports or send network requests yourself.
5. Adjust`start_reverse_proxy`, pass`script_path`, target`url`,`method`,`usage`; default`mode=adapter`. Ports, network sending, MITM routing, and processes are managed by the host.
6. Use`proxy`of`http_request`to create baseline and comparison requests. The host first encrypts the signature and then sends it through MITM; the response is returned along the original path and decrypted. Applicable to both HTTP and HTTPS.
7. Successful monitoring only means that the process is started. Write the fact`[REVERSE_READY]`after checking the real response and the encrypted signature; write a gap if it cannot be verified, and write`[REVERSE_UNUSABLE]`if it is invalid. Just because the algorithm is usable does not mean that the vulnerability is established.

When traffic collection is enabled, the plain text view and the real online packets are associated with the same`request_id`.`capture_id`is a view used for business analysis, and`wire_capture_id`is a real HTTP message. Do not copy real credentials or keys to logs or summaries.

Before modifying parameters, use`traffic_candidates`to view the interface and existing checks, and then`claim_http_check`; reuse the results if the result is not received successfully. After receiving it, each`http_request`carries`check_id`, and the last`complete_http_check`saves the conclusion and evidence summary. Do not directly mutate the online ciphertext. Modify the plaintext and re-encrypt the signature.

Agents are recycled when tasks are paused, stopped, timed out, or deleted. The script is retained and restarted after resuming the task. A single agent can be stopped with`stop_reverse_proxy`. The old self-packaging script can only explicitly select`mode=legacy`, and will reject it when starting the collection to avoid silently bypassing MITM.
