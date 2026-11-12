# muse-ai-local-bridge — V2 fork

> **Fork note:** this is an unofficial fork (v0.2.0) of
> [tegarp00/muse-ai-local-bridge](https://github.com/tegarp00/muse-ai-local-bridge)
> (MIT, v0.1.0). The original MIT license is unchanged (`LICENSE`).
> V1 behaviour is preserved — every V1 tool works exactly as before.
> V2 only *adds*: persistent terminals, async exec, opt-in full shell,
> full git write, glob/regex search, a local skill loader, and a stdio
> MCP mode. See [PROTOCOL.md §10](PROTOCOL.md) and [SECURITY.md](SECURITY.md)
> before enabling the shell.

Give Muse AI scoped access to a local project folder — over a plain GET tool API.

You run one small server inside your project folder. It exposes your files and git
through authenticated HTTPS endpoints. Paste one sentence in chat and the assistant
connects: it can read, search, edit, patch, and run allowlisted commands — always
inside the folder you chose, never outside it.

Zero runtime dependencies. One file you can audit in ten minutes.

## Quick start

1. **Install Node.js 18+.** Nothing else.
2. **Install the bridge** (or run it once with `npx muse-ai-local-bridge`):
   ```sh
   npm install -g muse-ai-local-bridge
   ```
3. **Run the server inside your project folder:**
   ```sh
   cd ~/projects/my-project
   mbridge
   ```
   It prints your access token. Keep that terminal open.
3. **Expose it** with a tunnel you control. Any tunnel works — cloudflared,
   ngrok, Tailscale, … — e.g.:
   ```sh
   cloudflared tunnel --url http://localhost:8787
   ```
   Note the public URL it gives you. (Quick tunnels are fine for trying;
   for daily use set up a named tunnel — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).)
4. **In chat, paste:**
   > connect to my local bridge at https://your-tunnel-url
5. The assistant reads the skill from your URL, asks for the token through a
   secure card (never paste the token as plain chat text), verifies, and
   reports the mode and project roots it can see. You only paste the sentence
   and enter the token — no explaining needed.
6. **Done.** Ask it to read, search, edit, or run your build. Writes and commands
   always ask for your approval first.

## CLI

```sh
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
never enable it.

```sh
cd ~/projects/my-project
# Full power: persistent bash + long jobs + git commit/push
mbridge --allow-shell --allow-git-write
# Or via env / config.json (see config.example.json):
#   MUSE_BRIDGE_ALLOW_SHELL=1 MUSE_BRIDGE_ALLOW_GIT_WRITE=1 mbridge
```

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

### Tests

```sh
npm test   # node:test, stdlib only — 10 tests, spawns real servers on temp projects
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
