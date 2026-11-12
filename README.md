# muse-ai-local-bridge — V3 fork

> **Fork note:** this is an unofficial fork (v0.3.1) of
> [tegarp00/muse-ai-local-bridge](https://github.com/tegarp00/muse-ai-local-bridge)
> (MIT, v0.1.0). The original MIT license is unchanged (`LICENSE`).
> V1 behaviour is preserved — every V1 tool works exactly as before.
> V2 only *adds*: persistent terminals, async exec, opt-in full shell,
> full git write, glob/regex search, a local skill loader, and a stdio
> MCP mode. V3 only *hardens and speeds up*: a central fail-closed Gate,
> bounded processes with group kill, 1-spawn git, worker-thread search,
> rotating audit log. See [PROTOCOL.md §11](PROTOCOL.md) and
> [SECURITY.md](SECURITY.md) before enabling the shell.

Give Muse AI scoped access to a local project folder — over a plain GET tool API.

You run one small server inside your project folder. It exposes your files and git
through authenticated HTTPS endpoints. Paste one sentence in chat and the assistant
connects: it can read, search, edit, patch, and run allowlisted commands — always
inside the folder you chose, never outside it.

Zero runtime dependencies. One file you can audit in ten minutes.

## Quick start — 3 steps

1. **Install (once).** Node.js 18+ and the bridge:
   ```sh
   git clone https://github.com/fahmi0812/muse-ai-local-bridge.git
   cd muse-ai-local-bridge
   npm install -g .
   ```
2. **Set up ready-to-code mode (once).**
   ```sh
   mbridge setup
   ```
   This saves `allow_shell` + `allow_git_write` = `true` in
   `~/.muse-ai-local-bridge/config.json` (existing project roots are
   kept, the token file is untouched). Run it twice and nothing changes.
3. **Start coding.** In your project folder:
   ```sh
   cd ~/projects/my-project && mbridge code
   ```
   Keep that terminal open. Then publish it with a tunnel you control
   (e.g. `cloudflared tunnel --url http://localhost:8787`), and in chat
   paste `connect to my local bridge at <your-tunnel-url>`. The assistant
   asks for the token through a secure card (never paste the token as
   plain chat text), verifies, and reports the mode and project roots.
   Done — ask it to read, search, edit, or run your build. Writes and
   commands always ask for your approval first.

   After step 2, plain `mbridge` (no flags, no `code`) is already
   ready-to-code mode too. `mbridge code <folder>` works from anywhere
   and scopes the server to that folder. The old explicit form still
   works: `mbridge --allow-shell --allow-git-write`.

## CLI

```sh
mbridge code [folder] [options]   ready-to-code mode (shell + git write on)
mbridge setup                     one-time: save ready-to-code mode in config
mbridge [options]                 plain server (allowlist-only, unless setup)

npx muse-ai-local-bridge [options]

  --port <n>       listen port (default 8787)
  --read-only      read-only mode: read + git tools only, no writes or commands
  --allow <cmd>    add an exact command to the run_command allowlist
                   (repeatable; patterns with shell metacharacters are refused)
  --token-file <p> persist the token in file p (mode 0600) instead of the
                   default ~/.muse-ai-local-bridge/token
  --new-token      generate a fresh token, replacing the saved one
```

The server refuses to start from your home directory or a drive root — `cd` into
a project first. Your 256-bit token is generated once and saved to
`~/.muse-ai-local-bridge/token` (mode `0600`), then reused on every start —
so your assistant stays connected without re-entering it. Rotate it anytime
with `--new-token`.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | List the allowed project roots |
| `list_files` | List files (respects `.gitignore`, hides secrets) |
| `read_file` | Read a file, paginated (max 1 MB) |
| `search_code` | Literal search with context lines |
| `git_status`, `git_diff`, `git_log` | Git read tools |
| `write_file` | Atomic write (temp + rename, max 1 MB) |
| `edit_file` | Exact-match string replacement (must match exactly once) |
| `apply_patch` | Unified diff, fuzz factor 0 |
| `run_command` | Allowlisted commands only, no shell, exact match |

Wire details: [PROTOCOL.md](PROTOCOL.md). Threat model: [SECURITY.md](SECURITY.md).
Stuck? [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## V2 — powerful mode (opt-in, off by default)

V1 stays the default: allowlist-only `run_command`, no shell. V2 adds
power, but only when *you* turn it on at startup — a tool call can
never enable it. The easy way is `mbridge code` or a one-time
`mbridge setup` (see Quick start); the explicit flags still work:

```sh
cd ~/projects/my-project
# Full power: persistent bash + long jobs + git commit/push
mbridge --allow-shell --allow-git-write
# Or via env / config.json (see config.example.json):
#   MUSE_BRIDGE_ALLOW_SHELL=1 MUSE_BRIDGE_ALLOW_GIT_WRITE=1 mbridge
```

**Trade-off (why this is opt-in, not the silent default):** `code` /
`setup` only change *how you start the server* — they do not weaken
the Gate, the token, the root scope, or the audit log, and
`--read-only` still wins over both. But a full shell in the project
folder *can* read `.env` and run anything there, so the mode is only
ever switched on by an explicit operator action (`code`, `setup`, or
the flags) and the server prints a warning banner at startup. Plain
`mbridge` without `setup`/`code` stays allowlist-only. Details in
[SECURITY.md](SECURITY.md).

New tools (all in `/api/tools/list` when enabled):

| Tool | What it does |
|---|---|
| `terminal_create` / `terminal_send` / `terminal_read` / `terminal_kill` (+ `terminal_list`) | One persistent `bash` per project. Send `echo hello\n`, read the buffered output later — for long or interactive-ish work. |
| `exec_start` / `exec_poll` / `exec_kill` | Long build/test as an async job: start it, poll until `done`, no more waiting on one HTTP call. |
| `git_branch`, `git_commit`, `git_push`, `git_checkout` | Full git write (commit/push/checkout need `--allow-git-write`). |
| `glob_files`, `grep_code` | `**/*.md` globs and real regex search, not just literal `search_code`. |
| `list_skills`, `read_skill` | Read local `SKILL.md` skills from `skills/`, `.agents/skills/`, `.opencode/skills/` in the project — so Muse web can use your local skills like Lumitome does. |

Example — terminal from chat:

```
terminal_create  →  { id: "term-1" }
terminal_send { id: "term-1", input: "npm test\n" }
terminal_read { id: "term-1" }   →  output so far, poll again if still running
terminal_kill { id: "term-1" }
```

**Safety rule for V2:** `--allow-shell` means a shell in your project
root — it *can* read `.env` via the shell and run anything there.
Only use it behind a private tunnel (Tailscale / named Cloudflare
tunnel), never a public quick-tunnel URL. `--read-only` still disables
everything writable, including shell and git write. Full trade-off in
[SECURITY.md](SECURITY.md).

### V2 — MCP mode (for OpenCode / Claude Desktop)

```sh
node server.js --mcp --allow-shell --allow-git-write
```

Stdio JSON-RPC MCP server — no HTTP port, no token over stdio (local
process only). Add it as a local MCP server in OpenCode
(`opencode.json`, `mcp.muse-bridge`, `type: local`,
`command: ["node", "<path>/server.js", "--mcp", "--allow-shell"]`).
It exposes exactly the tools the flags allow. Details: [PROTOCOL.md §10.6](PROTOCOL.md).

## V3 — hardened + faster (opt-in changes: none — same flags, same tools)

V3 keeps all 27 tool names and response shapes, and fixes the six root
causes from the v3 full critique (`FULLCRITIC-v3.md`):

- **One Gate, fail-closed** (`lib/gate.js`): git refs can no longer
  start with `-` (no `--force` injection via `git_push`/`git_checkout`),
  `git_commit all:true` enumerates files and filters secrets instead of
  a raw `git add -A`, regexes are length-capped + nested-quantifier
  checked and run in a worker thread with a 2 s timeout, single-file
  search is size-checked before reading. Disable the Gate and every
  write/shell/git tool refuses (`GATE_DISABLED`).
- **Bounded processes** (`lib/process-manager.js`): max 8 terminals /
  16 jobs (env-overridable), LRU eviction, idle TTL, process-group kill
  — no orphaned `sleep`/`build` processes after a kill or timeout.
- **Faster git + reads** (`lib/git-service.js`, `lib/fs-service.js`):
  `git_status`/`git_branch` are 1 spawn per call, `list_files` uses a
  2 s walk cache (invalidated on write), `read_file` uses a range read,
  search/grep run in a warm worker thread.
- **Honest audit** (`lib/audit.js`): rotates at 10 MB (keep 3), fails
  loud instead of swallowing errors, never logs terminal input.
- **Token to stderr only** at startup; extended secret blocklist
  (`.npmrc`, `.git-credentials`, `credentials.json`, `*.token`,
  `.docker/config.json`, `.netrc`); `read_file` offset documented as
  0-based (the code was always 0-based).

Benchmarks: `node test/bench.mjs` (thresholds recalibrated 12 Nov 2026
in `test/bench.mjs` header — the original DESIGN-v3 §5 absolutes
<6 ms / <15 ms / <3 ms proved unrealistic on this VM and were revised
with measured reasons, not forced). On the sandbox VM the big wins are
`list_files` on a large tree (~10 ms → ~2 ms cache-hit), search/grep
via a warm worker with a `Buffer.includes` prefilter, and the search no
longer blocking the event loop; git/search/read latencies sit at the
raw-cost floor of this VM (spawn ~3 ms, git status on a committed
803-file tree ~6–56 ms raw, stat+read of 803 files ~20 ms under
contention), so the recalibrated thresholds are VM guardrails, not
latency claims — see `CHANGELOG.md` for the measured numbers.

### V3 — deferred (P2, explicitly NOT implemented)

- **PTY** (`node-pty`): would break zero-deps (native module, per-platform
  build) for interactive programs only a minority needs; the non-PTY
  terminal already covers scripts, builds and tests.
- **Sandbox (`bwrap`)**: Linux-only, needs `bwrap` installed, and would
  change the shell's reach in ways that break legitimate project-local
  workflows; the documented trade-off (shell can read the root) stays
  honest instead.
- **Streaming (SSE/NDJSON)**: a new transport on top of polling, with no
  measured need — polling costs ~1 ms per round-trip locally, and tunnel
  latency dominates in real use anyway.

All three stay out of the default path on purpose: v3's promise is
"same tools, safer, faster" — not a new runtime.

### Tests

```sh
npm test   # node:test, stdlib only — 33 tests (10 v2 + 23 v3), spawns real servers on temp projects
node test/bench.mjs   # benchmark harness (in-repo): git/search/list_files/read_file/terminal/exec/MCP vs thresholds
```

## Multiple projects

Create `~/.muse-ai-local-bridge/config.json`:

```json
{ "roots": ["/home/you/projects/my-project", { "name": "blog", "path": "/home/you/projects/blog" }] }
```

One server then serves every root; each tool takes an optional `project`
(name or path) argument. See [config.example.json](config.example.json).
Without a config file, the server scopes itself to the folder you ran it in.

The config is re-read whenever the file changes — add or remove a project and
it takes effect on the next call, no restart needed.

Don't want to hand-edit JSON? Manage projects from the terminal
(`mbridge` is a short alias for `muse-ai-local-bridge`):

```sh
mbridge add ~/projects/my-project   # add a project
mbridge remove my-project           # remove by name or path
mbridge list                        # show registered projects
```

(With npx: `npx muse-ai-local-bridge add ~/projects/my-project`.)

## Revoking access

Kill the server (`Ctrl+C`) and stop the tunnel. Note that the token itself
persists across restarts, so killing the server alone does not revoke it. To
revoke a token for good, rotate it — start once with `--new-token` (or delete
`~/.muse-ai-local-bridge/token`) — and any client holding the old token loses
access.

## Too lazy to set this up?

This bridge is deliberately DIY: you run the server, you run the tunnel, you
guard the token yourself.

If you'd like a more integrated experience, there is [AugentFlow](https://augentflow.com),
a desktop app by the same people. It provides the MCP server right inside the
app — though you still run a tunnel so Muse AI can reach your machine — and
adds approvals before file changes or commands run, a task board, an execution
queue, and git workflows like commit & push.

Same people build both; this bridge stays MIT-licensed and independent
either way.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed — fork it, commercialize it,
strip the section above if you want. That's the deal.
