/**
 * Wave-6 CLI help text. Hand-rolled, lists all commands, flags, and env vars.
 */

const HELP = `
sleek — local PR code reviewer

USAGE
  sleek <command> [flags]

COMMANDS
  review [<pr>]           Run the review pipeline and serve the UI
  connect                 Print the active local Sleek server for this repo/PR
  list                    List scaffolds in the store
  regions <pr>            Dump changed regions (anchors) for a PR
  clean                   Show (or remove) caches and pooled worktrees
  finish <pr>             Finish a review and remove its active worktree/cache

Run sleek <command> --help for per-command flags.

REVIEW FLAGS
  sleek review <pr>
    --repo <path>         Repo path (default: cwd)
    --port <n>            Port to bind (default: server picks a free port)
    --open                Open the browser on macOS after listen
    --refresh             Bypass the gh response cache (SLEEK_REFRESH=1)
    --json                Emit one JSON object on stdout; progress on stderr
    --process             Run the scaffold pipeline eagerly at startup (default: explore-first)

  sleek review  (no args)
    Interactive repo picker, then PR picker (requires TTY).
    With --repo: skip repo picker. Non-TTY: numbered list + exit 1.
    Pick "Clone another repo..." to clone a missing GitHub repo first.

CONNECT FLAGS
  sleek connect
    --repo <path>         Repo path (default: cwd)
    --pr <n>              PR number (default: infer via gh pr view)
    --json                Emit JSON with URL and agent API endpoints

AGENT SKILL
  Install the Sleek agent skill from this checkout:
    npx skills add . --skill sleek-agent --agent codex --global
    npx skills add . --skill sleek-agent --agent claude-code --global
    npx skills add . --skill sleek-agent --agent cursor --global

  From a hosted Sleek repository, use the same command with the repo source:
    npx skills add <owner>/<repo> --skill sleek-agent --agent codex --global
    npx skills add <owner>/<repo> --skill sleek-agent --agent claude-code --global
    npx skills add <owner>/<repo> --skill sleek-agent --agent cursor --global

LIST FLAGS
  sleek list
    --repo <path>         Repo path (default: cwd)
    --json                Emit JSON array on stdout

REGIONS FLAGS
  sleek regions <pr>
    --repo <path>         Repo path (default: cwd)
    --json                Emit JSON on stdout

CLEAN FLAGS
  sleek clean
    --repo <path>         Repo path (default: cwd)
    --yes                 Actually delete (default is dry-run)
    Note: .sleek/demo.db is NEVER deleted (holds threads/reviews)

FINISH FLAGS
  sleek finish <pr>
    --repo <path>         Repo path (default: cwd)
    --yes                 Actually delete (default is dry-run)
    Note: removes the active PR worktree and disposable cache DB only.

ENVIRONMENT VARIABLES
  SLEEK_REFRESH=1                     Re-fetch gh responses (bypass cache)
  SLEEK_REPO_ROOTS=/path/a:/path/b    Repo picker scan roots; first root is clone target
  SLEEK_GH_BIN=/path/to/gh           Override gh binary path
  SLEEK_OLLAMA_MODEL=<name>           Ollama model for chat/ask
  SLEEK_CONTEXT_MODE=<mode>           Context reader mode
  SLEEK_SCAFFOLDER_PROVIDER=<name>    Scaffolder: claude|codex (anthropic|custom: env-only)
  SLEEK_SCAFFOLDER_COMMAND=<tmpl>     Custom scaffolder command template
  SLEEK_SCAFFOLDER_TIMEOUT_MS=<ms>    Scaffolder CLI call timeout (default: 1800000)
  SLEEK_AGENT_TIMEOUT_MS=<ms>         CLI call timeout fallback for all agent spawns
  SLEEK_SCAFFOLD_RUN_TIMEOUT_MS=<ms>  Job-level watchdog (default: 2700000)
  SLEEK_AGENT_RETRIES=<n>             Retry count for failed CLI calls (default: 1)
  SLEEK_CLI_RTK=0                     Disable rtk --allowedTools rules on claude spawns
  SLEEK_CLI_SESSION_FORK=0            Disable --resume --fork-session on detail calls
  SLEEK_ESCALATION_PROVIDER=<name>    Escalation provider (same options)
  ANTHROPIC_API_KEY=<key>             API key for anthropic scaffolder
  OLLAMA_HOST=<url>                   Ollama server URL (default: http://localhost:11434)

  See docs/CLI-AGENTS.md for scaffolder provider details.

EXIT CODES
  0   Success
  1   User/environment error (missing auth, bad PR number, etc.)
  2   Unexpected internal error
`;

export const COMMAND_HELP: Record<string, string> = {
  review: `
sleek review [<pr>] [flags]

Run the review pipeline for a PR and serve the review UI.

  sleek review 123 --repo /path/to/repo --port 63788
  sleek review 123 --repo /path/to/repo --json | node -e "process.stdin.resume()"
  sleek review  # interactive repo picker, clone option, then PR picker (requires TTY)

FLAGS
  --repo <path>    Repo path (default: cwd)
  --port <n>       Port to bind (default: server picks a free port)
  --open           Open the browser (macOS only) after listen
  --refresh        Bypass gh response cache
  --json           Emit one JSON object {pr,headSha,port,url,stages} on stdout
  --process        Run the scaffold pipeline eagerly at startup (default: explore-first)
`,
  connect: `
sleek connect [flags]

Find the active local Sleek review server for the current repo/PR and print
agent endpoint URLs.

  sleek connect --json
  sleek connect --repo /path/to/repo --pr 123 --json

FLAGS
  --repo <path>    Repo path (default: cwd)
  --pr <n>         PR number (default: infer via gh pr view --json number)
  --json           Emit JSON with url, PR metadata and /api/agent endpoints

AGENT SKILL
  npx skills add . --skill sleek-agent --agent codex --global
  npx skills add . --skill sleek-agent --agent claude-code --global
  npx skills add . --skill sleek-agent --agent cursor --global
`,
  list: `
sleek list [flags]

List all PRs with stored scaffolds in the repo's .sleek/demo.db.

FLAGS
  --repo <path>    Repo path (default: cwd)
  --json           Emit JSON array on stdout
`,
  regions: `
sleek regions <pr> [flags]

Dump the changed regions (anchors) for a PR. Useful for authoring
scripts/reviews/<pr>.json (see src/review/pipeline.ts for the format).

FLAGS
  --repo <path>    Repo path (default: cwd)
  --json           Emit JSON on stdout
`,
  clean: `
sleek clean [flags]

By default: print what would be removed (dry run).
Pass --yes to actually delete.

NEVER touches .sleek/demo.db (holds threads, reviews, saved replies).
Skips worktrees modified < 1 hour ago (possibly in use).

FLAGS
  --repo <path>    Repo path (default: cwd)
  --yes            Actually delete (default is dry-run)
`,
  finish: `
sleek finish <pr> [flags]

Finish a review by deleting the active pooled worktree for the PR head SHA and
the repo's disposable .sleek/cache.db files. NEVER touches .sleek/demo.db.

FLAGS
  --repo <path>    Repo path (default: cwd)
  --yes            Actually delete (default is dry-run)
`,
};

export function printHelp(command?: string): void {
  if (command && COMMAND_HELP[command]) {
    process.stdout.write(COMMAND_HELP[command]! + "\n");
  } else {
    process.stdout.write(HELP + "\n");
  }
}
