# Sleek UI/UX Parity Roadmap — vs GitHub PR Review & Graphite

> Goal: near-full feature parity with the review UIs of GitHub and Graphite, plus the
> things only Sleek can do (Layers, local AI, context bundles). Grounded in a feature
> inventory of both tools (2025–2026 docs); bindings and behaviors below reference their
> documented conventions.

## Where Sleek stands today (post v5)

Have: GitHub-coordinate anchors · layer (reading-order) navigation with three-state
scoping · sticky dual gutters · inline AI findings with severity/concern · sticky
line selection (click + shift-click, keyboard) · clean copy (no gutters/markers in
clipboard) · Copy button · hide-comments toggle · responsive · live-detected local AI
chat (streams from Ollama when served; stub in static artifact) · PR/commit links.

Missing vs the leaders: everything below.

## The one structural decision (make first)

**Unify all comments into a single thread model.** Graphite's key AI pattern: AI output
enters the *same* thread/pending-comment model as humans. Today Sleek renders Findings
as a bespoke one-way row. Instead: one `Thread` primitive — anchored to `{file, side,
startLine, endLine}` — with typed authors (`opus-finding`, `reviewer`, `assistant`),
replies, resolve/unresolve, and markdown bodies. Opus Findings become the opening
comments of threads; the Reviewer replies; "Ask qwen about this thread" posts the
assistant's answer *into the thread*. This collapses three future features (user
comments, replies-to-findings, AI-in-thread) into one build and is the prerequisite for
pending-review batching.

Storage: `threads` + `comments` tables in the existing SQLite store (M4), served over
the local server; static artifact renders threads read-only.

## Parity matrix → waves

### Wave 1 — Diff-viewer credibility [the "feels professional" floor]
| Item | Reference behavior | Sleek approach |
|---|---|---|
| Syntax highlighting | GH+GR | Highlight at RENDER time in TS (server/static both): small tokenizer for TS/JS/JSON/CSS/HTML + generic fallback; emit spans; no CDN (CSP) |
| Word-level intraline diff | GH+GR | Pair adjacent del/add runs, char-LCS, `<mark>` the changed spans |
| Expandable context | GH (~20 lines/click) | Live: `/api/context` reads from the worktree; static: embed ±10 lines per hunk at render, "expand" reveals |
| Unified/split toggle | GH+GR, saved per user | Rebuild rows into side-by-side pairs client-side; persist in localStorage |
| File tree panel | GH+GR (GR: `F`) | Replace flat file list: tree with dir collapse, +/- per file, new/deleted color |
| Viewed checkboxes + progress | GH | Per-file "Viewed" collapses card; progress bar in header; persist per head SHA |
| Whitespace toggle | GH+GR | Recompute intraline ignoring WS; hide WS-only rows |
| File-level collapse-all, large-file guard | GH | Collapse-all control; auto-collapse >400-row files with "Load diff" |

### Wave 2 — Commenting parity [the load-bearing wave]
| Item | Reference | Sleek approach |
|---|---|---|
| Thread model (see above) | GH+GR | `Thread`/`Comment` in domain + store + API; findings migrate in |
| Single & multi-line comments | GH: click+shift-click; GR: drag | From existing selection: `c` or "Comment" in action bar |
| Comment on unchanged lines | GR-only differentiator | Our anchors already support it (ctx rows have both line numbers) |
| Replies, resolve/unresolve | GH+GR | Thread footer: reply box, Resolve; resolved threads collapse to a pill |
| Markdown everywhere | GH+GR (GFM) | Self-contained mini-GFM renderer (headings, bold/italic/code, fences w/ highlighting, lists, links, tables, blockquotes) — used for findings, comments, chat questions AND streamed answers |
| Suggested changes | GH+GR: ```suggestion + batch apply | Phase A: render suggestion blocks as mini-diffs in comments (incl. Opus `suggestedFix` slot — already reserved in schema). Phase B: "Apply" writes to the worktree via server + marks applied |
| Pending review + submit | GH+GR: batch, then Approve/Request-changes/Comment; GR: pinned review bar | Local "review draft": comments accumulate as pending (dashed border), pinned bottom bar shows count, submit = finalize locally (Wave 4 exports to GitHub) |
| Review summary | GH+GR | Free-text md summary on submit, stored with the review |

### Wave 3 — Keyboard-first [own this]
Proposed full map (conventions: GH `?`/`t`/`Cmd+Enter`; GR chords `r→a/n/c/y`, single-letter panels; j/k vocabulary neither ships in-diff):

| Key | Action |
|---|---|
| `?` | Help overlay (all bindings, dismissible) |
| `j` / `k` | Next / prev change block (hunk) — scrolls + focus ring |
| `n` / `p` | Next / prev unresolved thread |
| `]` / `[` | Next / prev file |
| `1..9` | Jump to layer N (our reading order) |
| `f` | Cycle findings in active layer (exists) |
| `t` or `Cmd+K` | Jump palette: fuzzy files + layers + threads |
| `x` / `shift+x` | Select line / extend selection (exists via gutter; add row-focus path) |
| `c` | Comment on selection (opens thread composer) |
| `y` | Copy selected code (exists as button) |
| `v` | Mark current file viewed + collapse + advance |
| `s` | Toggle split/unified |
| `w` | Toggle whitespace |
| `h` | Toggle comments visibility (exists as button) |
| `a` | Ask local model about selection (focus chat with context) |
| `A` | Ask Opus (escalate) |
| `r` then `a/n/c` | Finish review: approve / request changes / comment (GR chord) |
| `Cmd+Enter` | Submit comment; `Cmd+Shift+Enter` submit review |
| `Esc` | Progressive dismiss (composer → selection → scope) |

Plus GR's discoverability pattern: persistent hint strip at panel bottom with the 4-5
contextual keys.

### Wave LSP — Language intelligence (live mode only)
| Item | Behavior | Sleek approach |
|---|---|---|
| Minimal LSP client | spawn/initialize/didOpen + hover/definition/diagnostics over stdio | Hand-rolled JSON-RPC framing in `src/lsp/` (no heavy deps); one adapter per language |
| ts/js | hover, go-to-def, per-file diagnostics | `typescript` package LanguageService against the worktree (no binary needed); tsconfig-aware when cheap, single-file semantic mode otherwise |
| rust | same | `rust-analyzer` detected on PATH; absent → disabled with install hint |
| java | same | `jdtls` detected; same degrade |
| Server API | `/api/lsp/hover`, `/api/lsp/definition`, `/api/lsp/diagnostics` (file+line+col in worktree coords) | Anchors already carry file+side+line; RIGHT side maps to worktree@head |
| UI | hover tooltip on symbols in diff; "peek definition" panel. Diagnostics UI (squiggles + header dots) shipped, then withdrawn: monorepo cross-package types resolve through stale built `node_modules`, so a PR that adds a shared-type property and uses it squiggles its own correct code. Hover/def stay; `/api/lsp/diagnostics` stays server-side for a future opt-in. | Live-detected like chat; static mode unaffected |
| Later | LSP references → upgrade M2 graph neighbors | Feeds Context Bundles, not just UI |

### Wave 4 — Round-trip & extras
- Export/post review to GitHub via `gh api` (threads → review comments at anchors,
  suggestion blocks preserved; our anchor format is already GitHub's).
- "Changes since last scaffold" (GR versions-lite): diff old vs new head SHA scaffolds
  from the store; staleness banner gains a "what changed" view.
- Scrollbar thread markers (GR) · file filter (GH) · saved replies · word wrap.

### Wave 5 — Performance & pipeline
Principle: measure first, then cache what's immutable and parallelize what's independent.
- **Baseline instrumentation**: per-stage timing (ingest → worktree → regions → history →
  neighbors → scaffold → render → listen) printed at startup; keep it, it's the perf UI.
- **Content-addressed caches** (SQLite KV in `.sleek/`): `gh pr diff` keyed by headSha
  (immutable); built ContextInput keyed by (headSha, regions-hash) — history + neighbors
  are deterministic per SHA; rendered HTML keyed by (pr, headSha, data-hash,
  renderer-version-hash). `gh pr view` gets a short TTL + `--refresh` escape hatch.
- **Worktree pool**: reuse the per-(repo, sha) worktree across restarts instead of
  mkdtemp+destroy; registry + the existing stale-sweep guard it.
- **Parallel context build**: per-region history/neighbor extraction fans out with a
  small concurrency cap (git subprocess guard).
- Target: warm server restart < 3s (was ~15–20s); cold path bounded by network, not us.

### Wave 6 — CLI/TUI ergonomics
Today's `npx tsx scripts/serve-demo.ts <repo> <pr> [port]` becomes a real `sleek` bin:
- `sleek review <pr> [--repo .] [--port] [--open]` — full pipeline + serve + open browser;
  `sleek list` (scaffolds in store) · `sleek regions <pr>` · `sleek clean`.
- No-arg `sleek review` → interactive PR picker from `gh pr list` (arrow keys).
- Staged progress lines with timings (hand-rolled, no dep), friendly failures (gh not
  authed, Ollama down, no authored review → exact next command), `--json` for scripts.

### Wave 7 — Explore-first + in-app model choice
Open a PR instantly with NO scaffold — diff, tree, selection, comments, LSP all work,
just no Layers/Findings — then process on demand:
- Header "Process PR" button → model picker (Scaffolder: Claude Code CLI with Fable 5 /
  Opus 4.8 / Sonnet, or Codex CLI, or authored-JSON Replay; ANTHROPIC_API_KEY-gated API
  rows no longer exist (superseded: provider trim in c195981 removed the direct Anthropic
  API picker rows); Assistant: installed Ollama models from a new `/api/models`) →
  `POST /api/scaffold` runs the real two-phase Scaffolder with streamed progress; UI swaps
  the scaffold in when done.
- Assistant model switchable any time (dropdown by the status chip); choices persisted
  per PR in the store. First wave to exercise the REAL Scaffolder path end-to-end.

### Wave 8 — Comment visibility & code actions
- Local-only vs publishable Comments: a per-Comment tag (default publishable for
  reviewer Comments) shown as a chip in the thread UI; the Wave-4A GitHub export
  filters local-only Comments out of the posted payload. Finding/assistant comments
  stay implicitly local.
- Right-click context menu on diff lines: git blame for the line, see source (open the
  file at head in the worktree/editor), copy GitHub permalink at the anchor, copy
  path:line. Menu items degrade gracefully in static mode.

### Deliberately out of scope
Stacked PRs, review queues/inbox (multi-PR product), reactions/GIFs, image diffs,
rich-md rendered diffs, blame view. Revisit post-parity.

## Constraints that shape everything
- **No CDN, ever** (artifact CSP + offline promise): highlighting, markdown, icons all
  hand-rolled/inlined at render time.
- **Two render modes stay**: static artifact (read-only, embedded data) and live server
  (interactive: threads, apply, context expansion). Every Wave-2+ feature must degrade
  gracefully to static.
- **The renderer is one TS module** (`scripts/render.ts` → promote to `src/render/` as
  it grows past ~1.5k lines; split: parse / highlight / html / client-js).
