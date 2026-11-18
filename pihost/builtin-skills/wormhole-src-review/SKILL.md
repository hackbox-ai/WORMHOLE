---
name: wormhole-src-review
description: Special selection, trust boundary, variant analysis and knowledge routing for SRC business vulnerability mining and white-box source code auditing. Use on-demand only if the task belongs to SRC or source code audit.
---

# SRC and white box project

The given scope of the task and the current workspace are used as boundaries; the group name or brand name is just a seed and does not automatically authorize affiliated companies or third-party assets. If you already have authorization, you will not be questioned again. New targets must comply with the scope of the task. Special projects are selected based on real business, user goals and verifiable impact; there is no fixed number of vulnerabilities and no entire types of tests are excluded in advance.

## SRC

Prioritize understanding of identity, business objects and processes, and establish negatible hypotheses around authentication, object ownership, status changes and external integration; choose directions with actual impact based on user goals. Versions, missing headers, and error pages can only form clues and do not automatically report holes.

Asset seed → Available business entrance → JS/API and identity → Control test → Evidence → Platform writeback. Each path has a budget and stopping conditions; new seeds are handed over to the Planner, and the Worker does not start an infinite group-wide cycle on its own. CORS, click hijacking, etc. are judged based on task policies and actual impact, and cannot be globally banned or reported as vulnerabilities.

## White box

Read [references/source-review.md](${SKILL_DIR}/references/source-review.md). First establish the entry-middleware-permission-data flow model, and then trace back the source/filter/reachability conditions from the dangerous sink; historical repair is used to find variants with the same root cause. Possible paths on the source code are recorded separately from actual running verification.

## Tools and Products

Reuse the existing skills visible to the current role such as api-recon / playwright-cli / scopesentry; the MCP name and schema are subject to the actual configuration, and the desktop Agent tool name is not copied. The source code, JS, scripts and attachments are placed in the current task CWD given by the host, the Desktop task root is not created, and the token is not copied to the Markdown queue.

Record capability gaps without dedicated reverse engineering/browser/intelligence tools and do not claim to have been executed. Candidates, negative examples and blocking are written back through existing facts; vulnerabilities are only registered after confirmation, and the report is submitted to the Reporter.
