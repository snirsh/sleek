---
name: sleek-agent
description: Use when working on a GitHub PR that is being reviewed in Sleek, when asked to connect an agent to Sleek, read Sleek review context, inspect GitHub conversation state through Sleek, or create local Sleek draft review comments.
---

# Sleek Agent

Use Sleek as the source of truth for PR review context and local draft comments.

## Connect

From the repository under review, discover the running Sleek server:

```bash
sleek connect --json
```

If the PR number is known, prefer the explicit form:

```bash
sleek connect --pr <number> --json
```

The JSON response includes `url`, PR metadata, and the agent API endpoints.

## Read Context

Fetch the model context before drafting comments:

```bash
curl "$SLEEK_URL/api/agent/context"
```

Use this response for:

- PR metadata and head SHA.
- Scaffold layers and anchors.
- Local Sleek threads.
- Published GitHub conversation summaries.
- Endpoint URLs.

Fetch normalized comments when the task is specifically about conversation state:

```bash
curl "$SLEEK_URL/api/agent/comments?refresh=1"
```

## Create Draft Comments

Agents may create local Sleek drafts only. Do not submit reviews or post to GitHub.

Create a local draft reviewer comment:

```bash
curl -X POST "$SLEEK_URL/api/agent/comments" \
  -H 'content-type: application/json' \
  -d '{
    "anchor": {
      "file": "src/example.ts",
      "side": "RIGHT",
      "startLine": 12,
      "endLine": 12
    },
    "body": "Comment body"
  }'
```

Rules:

- Default to local-only drafts.
- Anchor comments to exact changed lines when possible.
- Use `side: "RIGHT"` for new/head lines and `side: "LEFT"` for old/base lines.
- Do not call `/api/review/submit` or `/api/review/export`.
- Leave visibility and final submission decisions to the human reviewer unless explicitly instructed.

## Fallback

If `sleek connect --json` cannot find a server, tell the user to start Sleek for the PR:

```bash
sleek review <pr>
```
