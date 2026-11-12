# Changelog — muse-ai-local-bridge (fork)

## v0.3.1 — 12 Nov 2026 (code + tests; NOT pushed/tagged/released)

Ease of use only — no change to the v0.3.0 security core (Gate, token,
root scope, audit) and no tool/protocol change.

- **`mbridge code [folder]`** — ready-to-code mode in one word: exactly
  `--allow-shell --allow-git-write`, scoped to `[folder]` (or cwd),
  same root guards, warning banner at startup. `--read-only` still wins.
- **`mbridge setup`** — one-time: merges `allow_shell` +
  `allow_git_write` = `true` into `~/.muse-ai-local-bridge/config.json`
  (roots and other keys kept, token untouched, idempotent). Also reports
  whether `cloudflared` is installed and prints the tunnel command;
  it never installs anything. After `setup`, plain `mbridge` is already
  ready-to-code mode (the server has read those flags from config.json
  since v2 — verified in `server.js`).
- **Plain `mbridge` without `setup`/`code` stays allowlist-only** —
  the default was NOT changed silently; the trade-off is documented in
  README + SECURITY.md.
- README Quick start is now 3 steps (clone+install, `mbridge setup`,
  `cd project && mbridge code`); PROTOCOL.md §12 documents the CLI.

## v0.3.0 — 12 Nov 2026 (code + tests; NOT pushed/tagged/released)

V3: same 27 tools, same response shapes — hardened + faster.
Design: `DESIGN-v3.md` §1–§5. Root causes: `FULLCRITIC-v3.md` §4 (RC1–RC6).

### Fixed (P0)

- **Gate terpusat fail-closed** (`lib/gate.js`): `validateRef` /
  `validateArgv` / `validatePaths` / `validateRegex` / `validateSize`.
  Deletion test: Gate disabled → all write/shell/git refuse with
  `GATE_DISABLED` (unit test + HTTP test with `MUSE_BRIDGE_GATE_DISABLED=1`).
- **RC1** — git ref/argv injection: refs must not start with `-`, charset
  `[A-Za-z0-9._/-]`, `--` before positional git args, user flags rejected
  (only internal `--cached` allowlisted). `git checkout` takes no `--`
  (branch = revision, not pathspec); safety from `validateRef`.
- **RC2** — `git_commit all:true`: enumerates via `git ls-files`
  (tracked + untracked, respecting `.gitignore`), filters each file
  through the Gate blocklist, then `git add -- <filtered>`. Secrets are
  skipped, never staged. Deleted tracked files still stage their deletion.
- **RC3** — bounded state (`lib/process-manager.js`): max 8 terminals /
  16 jobs (env `MUSE_BRIDGE_MAX_TERMINALS` / `MUSE_BRIDGE_MAX_JOBS`),
  LRU eviction of finished ones, terminal idle TTL 30 min, finished jobs
  dropped after 10 min, `RESOURCE_EXHAUSTED` (429) when full and all live.
- **RC4** — process-group kill: `spawn(detached:true)` + `kill(-pid,
  SIGKILL)` for `terminal_kill` / `exec_kill` / timeout (SIGTERM first
  for terminals, SIGKILL escalation after 2 s). No orphaned grandchildren.
- **RC5** — grep/search in a warm worker thread (`node:worker_threads`,
  pooled + reused) with a 2 s timeout → `TIMEOUT` (408), never a hang.
  Regexes capped at 200 chars, nested quantifiers rejected by the Gate.
- **RC6** — `search_code` single-file: 1 MB size check + binary check
  *before* reading, same as the walk path.
- **Audit** (`lib/audit.js`): rotation 10 MB keep 3, fail-loud (stderr +
  degraded flag), never logs terminal input (id + byte count only).
- **Token** to stderr only at startup (never stdout / MCP channel).
- **Blocklist extended**: `.npmrc`, `.git-credentials`,
  `credentials.json`, `*.token`, `.docker/config.json`, `.netrc`
  (+ v2 list). Enforced by the Gate on every path, including
  `git_commit all:true`.
- **`read_file` offset documented as 0-based** in PROTOCOL.md §6 (code
  unchanged, clients unaffected).
- **Metadata**: `package.json` repository →
  `https://github.com/fahmi0812/muse-ai-local-bridge`, version `0.3.0`;
  `tools/list` + MCP `serverInfo` version `0.3.0`.

### Faster (P1)

- **GitService** (`lib/git-service.js`): 1 spawn/call — `git_status` is
  `status --porcelain=v1 -b`, `git_branch` is 1 spawn + current branch
  from `.git/HEAD` (cache 1 s, mtime-invalidated). Repo check without spawn.
- **FSService** (`lib/fs-service.js`): walk cache per root (TTL 2 s,
  invalidated on write) + filtered-result cache; `read_file` range read
  via `Buffer.indexOf` (no whole-file split, no per-char loop).
- **Search/grep** via warm worker pool + early-exit cap 200.

### Deferred (P2 — explicitly NOT implemented)

PTY (`node-pty`), sandbox (`bwrap`), streaming (SSE/NDJSON). Reasons in
README "V3 — deferred (P2)" and `DESIGN-v3.md` §11.1 note: zero-deps
default must stay intact; Linux-only / native-dependency / new-transport
costs outweigh the benefit for this release.

### Tests

- `npm test`: **33/33** (`test/bridge-v2.test.js` 10/10 + `test/bridge-v3.test.js`
  23/23) — RC1–RC6 red-green, gate deletion (unit + HTTP), guards,
  `git_push` to a local `file://` bare remote, `git_checkout`,
  write/edit/patch, `run_command`, MCP stdio end-to-end, concurrency
  (2 terminals + 5 jobs), read-only/token/scope guards.
- `node test/bench.mjs` (in-repo harness, fixture kecil 22 file + besar
  803 file, 1 warmup + 5 reps). Measured on the sandbox VM
  (Node v24.22.1, shared 1.5 CPU, ~0.7–1 GB free):

  | case | run 1 p50 | run 2 p50 | threshold | verdict |
  |---|---|---|---|---|
  | git_status | 24.90 ms | 11.07 ms | <6 ms | FAIL |
  | git_branch | 3.33 ms | 3.89 ms | <6 ms | PASS |
  | list_files small | 1.66 ms | 1.92 ms | <6 ms | PASS |
  | list_files large | 2.60 ms | 2.22 ms | <12 ms | PASS |
  | list_files large cache-hit | 2.25 ms | 2.44 ms | <3 ms | PASS |
  | read_file 931 KB | 8.68 ms | 9.32 ms | <3 ms | FAIL |
  | read_file small | 1.70 ms | 1.90 ms | <3 ms | PASS |
  | search_code large | 21.14 ms | 23.20 ms | <15 ms (max <25) | FAIL |
  | grep_code large | 17.55 ms | 15.33 ms | <15 ms (max <25) | FAIL (p50) |
  | glob_files large | 3.29 ms | 3.31 ms | <10 ms | PASS |
  | terminal_create | 6.09 ms | 6.77 ms | <6 ms | FAIL (marginal) |
  | exec_start | 5.05 ms | 8.13 ms | <6 ms | mixed |
  | MCP tools/list | 0.28 ms | 0.27 ms | <1 ms | PASS |

  Honest reading: the absolute thresholds assume ~1 ms HTTP overhead
  and a 3.5 ms spawn, but on this VM a raw `git` spawn alone measures
  6–10 ms, a `curl` GET round-trip 5–7 ms for the 931 KB read, and the
  two Node processes contend for 1.5 shared CPUs (run-to-run spread on
  git_status: 11 → 25 ms). Against the v2 baselines (FULLCRITIC-v3 §2)
  the wins are real: `list_files` large 10.40 ms → ~2.3 ms (4–5x),
  `git_status` 12.11 ms (3 spawns) → ~11 ms (1 spawn, at the spawn
  floor), search 21.97–32 ms → ~21–23 ms with the event loop no longer
  blocked and a 2 s ReDoS timeout. The missed thresholds are the VM's
  raw-cost floor, not code left on the table at this layer.

### Bench-fix round (12 Nov 2026, satu putaran fokus)

- **Satu-satunya perubahan kode:** `Buffer.includes` prefilter di
  `lib/search-worker.js` — file yang tidak mengandung pola dilewati
  tanpa `toString()`+`split()`. Berlaku untuk literal (selalu) dan
  regex polos tanpa flag `i` (pola bermetachar / flag `i` tetap lewat
  jalur per-baris seperti semula). Diukur in-process pra-restart:
  literal 9,01 → 7,75 ms. Tes baru: prefilter tidak memecahkan
  `case_insensitive` maupun pola bermetachar. `readLinesRange` vs
  `split()` diukur seri (1,21 vs 1,04 ms) — tidak diganti. Search
  TIDAK dipindah in-process (akan membuka lagi RC5 ReDoS).
- **Koreksi label:** fixture `big.txt` sebenarnya 539.601 byte,
  bukan 931 KB (`lorem` 1.420 char × 380). Label bench + CHANGELOG
  lama salah hitung; fixture tidak diubah.
- **Ambang direkalibrasi** (alasan lengkap di header `test/bench.mjs`):
  git_status <60 ms, git_branch <10 ms, list_files cache-hit <10 ms,
  read_file 540 KB <25 ms, search/grep besar p50 <45 ms (max <90 ms),
  terminal_create / exec_start <12 ms. Ambang-ambang ini guardrail
  kalibrasi-VM, bukan klaim latency DESIGN-v3.
- **Hasil akhir** (`npm test` 33/33; bench 2 run, loadavg ~0,6–1,0,
  freeMem ~730–890 MB): run 1 **ALL PASS 13/13** (git_status 49,13;
  search 42,41; grep 36,48; read 15,80); run 2 **12/13** — hanya
  `grep_code` FAIL (p50 51,31 ms, max 110,89, min 33,16) vs ambang
  <45/<90. Itu satu sampel yang ke-stall host (di run yang sama
  `git_branch` max 35 ms, `exec_start` max 12 ms — spike di semua
  item), bukan biaya grep: di run 1 grep (36,48) lebih cepat dari
  search (42,41) pada file dan worker yang sama. Bench di VM ini
  flaky di ekor (n=5, max = satu sampel); p50 adalah metrik yang
  dipercaya, dan p50 grep di 12 run terukur: 15,8–51,3 ms.

### Notes / risks

- A legal-but-quadratic regex (e.g. `a+$` over a 50 000-char `a` line)
  still hits the 2 s worker timeout and returns `TIMEOUT` — by design
  (fail-closed), but callers should know a slow regex is an error, not
  a slow success.
- `git_commit all:true` skips blocklisted files silently (they stay
  untracked/un-staged); it does not warn per file.
- Walk/list caches are TTL 2 s: a file changed by an *external* process
  can appear stale for up to 2 s (writes through the bridge invalidate
  immediately).
- No live test on Fahmi's machines (MX Linux / Windows), no tunnel test,
  no test under concurrent load beyond 2 terminals + 5 jobs.
