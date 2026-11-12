# Security

This document is deliberately honest about what the bridge enforces and what it
doesn't. Read it before exposing a server.

## What the server enforces

- **Authentication on every request.** A 256-bit token — generated once and
  stored at `~/.muse-ai-local-bridge/token` (mode `0600`) — is compared in
  constant time. No token, no access — every endpoint, every time.
  Persistence is deliberate: behind a tunnel (e.g. Cloudflare Zero Trust), a
  per-run token would force a full reconnect in your assistant after every
  local restart. The trade-off: a leaked token stays valid until rotated —
  treat that file like a password.
- **Localhost only.** The server binds to `127.0.0.1`. The internet can only
  reach it through *your* tunnel.
- **Scoped root.** The working directory (or each configured root) is the
  boundary. `..` traversal and symlinks escaping the root are rejected.
- **Secret blocklist.** `.env*`, `*.key`, `*.pem`, `.ssh/`, `.aws/`, `.gnupg/`
  and friends can never be read, listed, searched, or written — even inside the root.
- **No shell, ever.** Git helpers and `run_command` use argv arrays. There is no
  shell to inject into.
- **Allowlist, exact match.** `run_command` first rejects shell metacharacters,
  then requires the command to match the allowlist *exactly*. Prefix matching is
  deliberately not used: a prefix rule for `git diff` would also allow
  `git diff --no-index /etc/passwd ...`.
- **Atomic writes.** `write_file` / `edit_file` / `apply_patch` write to a temp
  file and rename. A crash mid-write never leaves a half-written file.
- **No silent corruption.** `edit_file` requires exactly one match; `apply_patch`
  requires every hunk to match at its exact position (fuzz 0). Ambiguity is an error.
- **Audit log.** Every write and command is appended to
  `~/.muse-ai-local-bridge/audit.log` on the machine running the server.

## What the server does NOT enforce — read this

- **Approvals live in the chat client, not here.** When you ask the assistant to
  write or run something, it is the *assistant's* job to ask your approval first.
  This server cannot tell whether the assistant asked. A client that skips
  approvals can write and run anything the allowlist permits.
- **`/` and `/skill.md` are public by design.** A fresh assistant must learn how
  to connect from the URL alone, so these two routes need no token. They carry
  no secrets — only connection instructions. Everything else requires the token.
- **Your tunnel is your perimeter.** Anyone holding your tunnel URL *and* the
  token has the same access you have in chat. Use a tunnel you trust, keep the
  URL private, and rotate the token with `--new-token` if it may have leaked —
  a plain restart does not rotate it; the token persists across restarts by
  design, so your assistant stays connected without re-entering it.
- **Tool arguments travel in URL query strings.** They can land in tunnel access
  logs. Never send passwords, API keys, or tokens through the tools — put secrets
  into files by hand, on the machine itself.
- **`.gitignore` support is a subset.** Negation (`!`) patterns are ignored.
  Treat listing/search as a convenience, not a guarantee that something is hidden.
- **No rate limiting.** The token is the only gate. Don't expose the tunnel URL
  publicly.

## Reporting a vulnerability

Open a GitHub issue, or email the maintainer privately if it's actively
exploitable. Please include the commit hash you're running and steps to reproduce.

## V2 additions — read before enabling `--allow-shell` / `--allow-git-write`

V1's guarantees still hold for V1 tools. V2 adds power with an explicit,
honest trade-off:

- **A shell in the project root can read anything in that root.**
  The V1 file tools refuse `.env` / `*.key` / `.ssh/` — a bash session
  does not. `terminal_send "cat .env"` will work. That is the feature
  (a real terminal is useful precisely because it can do anything) and
  also the risk. Treat `--allow-shell` like handing someone a terminal:
  only enable it when the tunnel is private (Tailscale, or a named
  Cloudflare tunnel with access control), never on a public quick-tunnel
  URL, and never on a shared machine.
- **Shell/git-write can only be enabled by the operator who starts the
  server** — via `--allow-shell` / `--allow-git-write` flags, env vars
  (`MUSE_BRIDGE_ALLOW_SHELL=1`, `MUSE_BRIDGE_ALLOW_GIT_WRITE=1`), or
  `allow_shell` / `allow_git_write` in `config.json`. A tool call from
  chat can never turn them on. `--read-only` overrides all of them.
- **Scope still holds:** terminals, exec jobs and git commands all run
  with cwd locked to the project root; path arguments still go through
  the V1 root resolver + blocklist (file tools, `git_commit --files`).
  Shell *commands* are not path-checked — that is inherent to a shell.
- **Audit:** every `terminal_create` / `terminal_send` / `terminal_kill`,
  `exec_start` / `exec_kill`, `git_commit` / `git_push` / `git_checkout`
  is appended to `~/.muse-ai-local-bridge/audit.log`, same as V1 writes.
  Terminal *output* is not logged (it may contain secrets) — only the
  command text (first 200 chars) is.
- **No sandbox in v2:** there is no bubblewrap / container around the
  shell. If you need containment, run the bridge inside a VM/container
  yourself, or don't enable the shell.
- **MCP mode (`--mcp`):** stdio is the trust boundary — no token is
  checked over stdio, because only the local process that launched the
  server can speak to it. Do not pipe MCP stdio over a network. Root
  scope, read-only mode, and shell/git-write flags still apply.
- **Terminal buffers are capped** at 512 KB per terminal / job (oldest
  output drops); `exec`/`terminal` output is never written to the audit
  log. Long-running terminals are not auto-killed — kill them when done.
