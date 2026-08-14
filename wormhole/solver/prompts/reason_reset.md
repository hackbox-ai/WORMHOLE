# Task — HYPOTHESIS RESET

The solver is STUCK. Recent exploration has been circling the same dead ends without progress toward the goal. Your job now is to **break out of the local minimum** by proposing attack surfaces that have NOT been tried yet.

You will receive a YAML snapshot of the task graph. Read it carefully — every concluded-but-flagless intent is a CONFIRMED DEAD END. Do not propose anything similar.

# What to do

1. Read the goal again. What EXACTLY is needed (a flag string? a specific file? RCE?)
2. List mentally every approach the previous intents already tried (the YAML shows them).
3. Identify attack surfaces, tools, or techniques that have NOT been attempted. Consider:
   - **Different protocols / ports** — is there a service you haven't probed? (UDP, ICMP, FTP, SMTP, DNS, SMB, RDP, custom TCP)
   - **Different entry points** — other URLs, other parameters, other HTTP methods, other content-types
   - **Different exploit variants** — if SQLi failed, try blind/time-based/DNS-exfil; if upload blocked, try race conditions or `.htaccess`
   - **Out-of-band channels** — DNS exfiltration, ICMP tunnel, reverse shell callback, blind SSRF via timing
   - **Privilege / role escalation** — try other users, default creds, JWT/session forgery, IDOR with different IDs
   - **Internal pivoting** — once you have any foothold, what other hosts are reachable? Have you enumerated the internal network fully?
   - **Source / config exposure** — `.git/`, `.env`, `web.config`, backup files, source maps, error stacks, debug endpoints
   - **Time-based / race conditions** — TOCTOU, concurrent requests, slow-loris, retry storms
4. Propose **at most {max_intents}** brand-new, non-overlapping directions. Each MUST be qualitatively different from what has been tried (different tool, different vector, different layer of the stack).

# Output Requirements

Return only one raw JSON object. No prose outside the JSON.

```json
{"accepted": true, "data": {"intents": [{"from": ["f001"], "description": "<NEW direction, not similar to any prior intent>"}]}}
```

If you genuinely cannot think of any untried direction (extremely rare — re-read the goal and the dead-end list once more before concluding this), return:

```json
{"accepted": true, "data": {"complete": {"from": ["origin"], "description": "Exhausted all reachable attack surfaces; goal unmet."}}}
```

## Rules
- Each proposed intent MUST be in a DIFFERENT category from every concluded intent in the graph. If an intent tested SQLi, do not propose another SQLi variant — propose something from a different vulnerability class.
- Be concrete: name the specific tool, the specific endpoint/port, the specific technique. "Try harder" is not a valid intent.
- Prefer high-EV bets: things that are likely to exist but haven't been checked, over fifth-order exploits.
- It is OK to propose exploring a hypothesis that may turn out negative — confirming "this vector is also dead" is itself progress that shrinks the search space.

## Context
{graph_reference}

### Valid facts
```
{fact_ids}
```

### Open Intents
```
{open_intents}
```
