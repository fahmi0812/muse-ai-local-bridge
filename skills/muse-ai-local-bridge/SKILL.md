# muse-ai-local-bridge skill

You are connected to (or connecting to) a local bridge server: a scoped window
into the owner's project folder(s). This file is public and needs no token.

## The owner just pasted a bridge URL (cold start — do this now)

1. You are reading this file. No token was needed for it.
2. Ask the owner for the token through the secure card. Never ask for it as
   plain chat text, never put it in a URL, and never explain headers or
   protocols — the owner just enters the token.
3. Verify: `GET <url>/api/tools/list` with header `X-Api-Key: <token>`.
4. Report the mode (`read-write`/`read-only`) and project roots in one line, then follow
   the Rules below. Done.

## Rules

- **Reads are free.** `list_files`, `read_file`, `search_code`, `git_*` need no approval.
- **Writes and commands ALWAYS need the owner's explicit approval first.**
  Show the exact path and full content (or the exact command), then wait for a
  clear "yes". Never bundle approvals for multiple writes into one ask.
- **Never read, write, or work around the secret blocklist** (`.env`, `*.key`,
  …). The server rejects these — don't try alternative paths.
- **Never attempt path traversal.** Stay inside the project root.
- **Never put secrets in tool arguments** — they travel in URL query strings.
- **Keep each call under ~7 KB.** Split large writes into sequential chunks.
- **Multiple roots:** pass `project` (name or path from `list_projects`).
  Default is the first root.
- If the owner revokes access (server stopped), say so plainly and stop.
  Don't retry in a loop.

## Tool semantics

- `list_files(path, max_depth, recursive, include_hidden)` — respects `.gitignore`.
- `read_file(path, offset, limit)` — paginated; 200 lines default, 1 MB max.
- `search_code(pattern, path, file_glob, context_lines)` — literal match, not regex.
- `write_file(path, content)` — atomic; creates parent dirs; 1 MB max.
- `edit_file(path, old_text, new_text)` — literal, must match **exactly once**.
- `apply_patch(path, patch)` — unified diff, fuzz 0: hunks must match at their
  exact positions or the whole patch is rejected.
- `run_command(command, timeout_s)` — the command must match the allowlist
  **exactly**; shell metacharacters are rejected. No shell is involved, so no
  pipes, redirects, or variable expansion — request `--allow` additions from the
  owner instead of working around it.

## V2 tools (only listed when the server was started with the matching flag)

- `glob_files(pattern, path, max_results)` — glob search, e.g. `**/*.md`.
- `grep_code(pattern, path, file_glob, context_lines, case_insensitive)` — regex search.
- `list_skills()` / `read_skill(name)` — local `SKILL.md` skills from
  `skills/`, `.agents/skills/`, `.opencode/skills/`. Read a skill before
  following it, and prefer it over guessing.
- `terminal_create()` / `terminal_send(id, input)` / `terminal_read(id, offset)` /
  `terminal_kill(id)` (+ `terminal_list()`) — persistent bash, only when
  `--allow-shell` is on. Send input with a trailing newline to run it;
  poll `terminal_read` until `running` is false.
- `exec_start(command, timeout_s)` / `exec_poll(job_id)` / `exec_kill(job_id)` —
  async long commands, only when `--allow-shell` is on.
- `git_branch()` (read), `git_commit(message, all, files)`, `git_push(remote, branch)`,
  `git_checkout(branch, create)` — git write needs `--allow-git-write`.
  If a tool is missing from `/api/tools/list`, its flag is off — say so
  plainly and ask the owner to restart the server with the flag, don't
  work around it.

## Errors

`ok:false` with a `code` is normal — report it plainly:
`PATH_OUTSIDE_ROOT`, `FILE_BLOCKED`, `COMMAND_NOT_ALLOWED`,
`COMMAND_REJECTED_METACHAR`, `BAD_ARGS` (read the message; often a fixable
detail like an ambiguous `old_text`).
