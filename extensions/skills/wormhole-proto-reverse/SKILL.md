---
name: wormhole-proto-reverse
description: Optional tool chain for binary/private protocol reverse engineering - reassemble TCP stream from pcap, cut into packets, count field candidates (length field, enumeration, CRC, entropy partitioning, type and state transfer), then use Construct to generate runnable parsing/packaging code and perform byte-by-byte round-trip verification. Suitable for non-HTTP protocols such as WebSocket, private TCP, industrial control/game/IM.
---

# Protocol reverse (optional)

First call analysis_capabilities to confirm the native capabilities; when components are not configured or missing, they are processed according to the return status, and it is not assumed that all backends are available.

When encountering non-HTTP private protocols (binary frames, custom TCP, WebSocket application layer messages), this set of tools can turn "guessing fields" into "verifying fields". **It’s up to you to decide whether to use it or not and which step to use**; in many scenarios, it’s faster to write your own scripts and steal bytes.

## What can it give you?

- **Reassembly**: Put the TCP segments back into byte streams in both directions according to the connection instance; out-of-order, retransmission, gaps, conflicts, and truncation are all accounted for
- **Split**: Split the stream into packets by length prefix/delimiter, and mark which packets span the gap
- **Candidate**: Length field position, CRC algorithm and position, constant offset, high entropy area, type discrimination bit, type transfer
- **Verification**: Use Construct definition to do parse→build, **byte by byte** and compare with the original message

It only gives facts and candidates, without drawing conclusions. **There are often more than one candidates** (the`candidates`field of`segment`will be listed), which must be eliminated by round-trip verification and real interaction.

## Prerequisite

| Situation | Judgment |
| --- | --- |
| The traffic is TLS and the key cannot be obtained | Solve the decryption first, do not reverse the ciphertext |
|`hints`marks a large area of high entropy | It may be a compression or encryption layer, peel it off first |
| Only one or two messages | The sample is too small and the statistics are meaningless |
| WebSocket | The TCP stream is a WS frame, not an application message; first look at the "entry" below |

## Entrance (two paths, don’t mix)

**A. The decoded message has been obtained** (WS message captured by browser MCP, message printed in your own agent, package exported by the peer):
Each message is saved as`msgs/0001.bin`,`0002.bin`...and then **directly uses`hints`and`verify`**, no need for pcap, and no need for`extract`/`segment`.

**B. Only raw TCP packet capture**: Take the following four steps. Note that`packet`mode cuts TCP segments, not WebSocket message boundaries; WS masks, fragments, and control frames need to be deframed by yourself first (this tool does not do this), and the decoded messages are processed in the same manner as A.

```bash
proto-re extract --pcap cap.pcap --port 9000 --out flows/
proto-re segment --dir flows/ --frame auto --out msgs/
proto-re hints   --dir msgs/flow01/a2b --json
proto-re verify  --spec spec.py --dir msgs/flow01/a2b
```

Products of`extract`:`<direction>.bin`(byte stream),`<direction>.meta.json`(gap/collision/retransmission/truncation),`<direction>.segments.json`(per-packet offset),`manifest.json`.

## Data integrity

- Fill the gap position with zero, but`gap_ranges`of`meta.json`will be written;`segment`marks the message across the gap as`incomplete`and writes`quality.json`
- When there is a **retransmission conflict**, **gap list truncated**, **over budget**, or **beginning data earlier than the baseline** in the stream, all packets in the entire stream will be marked as incomplete (conservative processing)
-`hints`and`verify`**Incomplete samples are skipped by default**. Recursive analysis of the upper directory will also read`quality.json`in the subdirectory; the skipped number will be printed out, and`--include-incomplete`must be added.
- Every time`extract`/`segment`will write`outputs.json`with **run ID**: the run root is`run/root/inputs`, and the leaf product is`run/owner`(which output it belongs to). When reading **Only the running root can authorize the file** - the leaf list is just a mark and does not count itself. Between running roots, press`inputs`to determine the upstream and downstream, and take the latest one: nested output (such as`flows/msgs/`) uses the root of msgs, and the direction left over from the previous round is not in the file table of the current root, and direct reading will clearly report "No sample available"
- Each time`extract`uses an **independent**`.spool-<pid>-<time>`temporary directory, retrying after failure will not read the last remnants; other`.spool-*`directories will not be automatically deleted
- Exceeding the upper limit in one direction (default 64 MiB) or exceeding the budget in total (default 512 MiB) will set`truncated`and record`budget_skipped_bytes`
- There are upper limits at all levels: 5000 connections, 200,000 packet-by-packet offsets in one direction, 100,000 packets in a single stream**, 8192 offset bits/5000 samples in byte-by-byte analysis, 256 MiB in total sample bytes**
- Will not hold on when the upper limit is reached: when the number of messages exceeds the limit, only cut the front part and write the remainder into`remainder.bin`, and mark`frames.json`at the same time`messages_truncated`; analyze the exceeding limit and mark`analysis_truncated`and`analyzed_offsets`
- The upper limit can be covered by environment variables (for testing):`PROTO_MAX_INSTANCES`,`PROTO_MAX_SEGMENTS`,`PROTO_MAX_MESSAGES`,`PROTO_MAX_ANALYZE_OFFSETS`,`PROTO_MAX_ANALYZE_SAMPLES`,`PROTO_MAX_SAMPLE_BYTES`
- If the meta information file exists but fails to parse, an error will be reported directly, and it will not be regarded as "no problem" by default.

## Manual segmentation

```bash
--frame length:6:2:be:payload:2 # offset 6, 2 bytes, big endian, payload length, tail 2 bytes non-length
--frame length:0:2:le:total # The length field contains the entire frame, little endian
--frame delim:0d0a # By delimiter
--frame packet # segment by TCP

The parameters will be verified:`SIZE`can only be 1/2/4,`OFF`/`TRAILER`cannot be negative, the endianness can only be be/le, and the mode can only be payload/remaining/total; errors will be reported directly if they are written, and they will not be silently parsed into wrong things.
```
When the tail is not cut cleanly, the remaining bytes will be written to`remainder.bin`in the same directory (the offset is recorded as`remainder.json`), and a prompt will be displayed in the output - this usually means that the length field or trailer has been guessed wrong.

## Construct definition

One definition is given to both parse and build, so it can be verified. To make the checksum truly "recalculate", the header must be defined separately and reserialized with the current field value:

```python
from construct import *

def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc

HEADER = Struct(
    "magic"   / Const(b"\xa5\x5a"),
    "type"    / Int8ub,
    "flags"   / Int8ub,
    "seq"     / Int16ub,
    "length"  / Int16ub,
    "payload" / Bytes(this.length),
)

MSG = Struct(
    "head" / HEADER,
    # parse: verification; build: recalculate based on the current head field value
    "crc"  / Checksum(Int16ub, crc16, lambda ctx: HEADER.build(ctx.head)),
)
```

Key points:

-`Checksum(field, algorithm, function to get bytes)`The order of the three parameters cannot be changed; the third one must return **Bytes to be verified**
- Don't use`Int16ub`to replace`Checksum`: that way you just move the old value back, and the round trip can be passed, but you have not verified that it will be calculated.
- Bad CRC will be rejected at the`parse`stage; so "change the sample CRC to see if it can pass" is not a valid test - the correct verification is to build after changing a field and check whether the CRC changes accordingly**

## Acceptance Criteria

**All samples must be consistent byte by byte** to pass; failure will result in inconsistent first offset and hexadecimal on both sides.
Four numbers`found / loaded / skipped incomplete / not verified due to budget` will be reported separately in the output: as long as there are samples that are not verified due to budget, it will only be counted as **partial verification**, and the exit code is non-zero,`--json`and`complete=false`. But note:

> Round-trip consistency only shows that the sample can be reconstructed without loss, but it does not prove that the field semantics are correct, the verification is calculated in this way, and a new message can be constructed**. The semantics depend on`types`/`transitions`and real interaction confirmation.

## Stateful part

`transitions`is grouped by "flow/direction" and counted according to the natural order of message serial numbers, which can give clues to "first A, then B"; it is not a state machine. Handshake, token rotation, and serial number increment must be drawn by yourself in conjunction with the interaction sequence.

## Cost

`extract`/`segment`/`hints`are purely local deterministic calculations, and the overhead increases with the sample size and stream length (several MB samples are usually within seconds); what is really expensive is letting the model interpret the candidates and write the Construct definition. It is recommended to **analyze each stream once** instead of throwing all streams in at once.

## Where does pcap come from?

- This machine can capture:`tcpdump -i lo -w cap.pcap port 9000`
- A proxy written by yourself: save the bytes and spell them into pcap (requires legal IP/TCP records,`extract`only recognizes pcap content)
- Browser: WS messages are usually decoded and go directly to portal A

## Common errors

| Phenomenon | Cause |
| --- | --- |
|`No TCP payload was parsed`| The pcap link layer type is not supported, or the filter conditions are written incorrectly |
| There are more bytes than expected after reorganization | Fill the gap with zeros; look at`gap_ranges`of`meta.json`, indicating that the packet is captured and lost |
| Only 1 piece left in automatic segmentation /`candidates`is empty | The length field is not in the first 8 bytes, or the length semantics is in another mode; manual`--frame`|
| A large number of samples were skipped | They crossed the gap and are not counted by default; confirm the impact area and add`--include-incomplete`|
| Round trip 0% | Wrong field order/width, see the first inconsistent offset |
| Round trip 100% but incorrect semantics | Correct bytes does not mean correct understanding; combined with interactive confirmation |
|`--frame length`reports parameter error | Check SIZE/OFF/endian/mode according to the above value |
| Prompt "Too many segmented records have been truncated" | If the number of packets in one direction exceeds`PROTO_MAX_SEGMENTS`,`--frame packet`will degenerate into the entire stream |
|`messages_truncated: true`| The number of packets in a single flow exceeds`PROTO_MAX_MESSAGES`. Only the first 100,000 are cut, and the remaining number is`remainder.bin`|
|`analysis_truncated: true`| The message is too long or there are too many samples. Only the first few bytes/samples are analyzed; the conclusion only covers this section |
|`verify`reports "partial verification" and the exit code is non-zero | Some samples cannot be regarded as fully passed because the read budget has not been verified; reduce the sample size or verify in batches |
