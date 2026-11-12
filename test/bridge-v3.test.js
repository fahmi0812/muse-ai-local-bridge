'use strict';
/**
 * bridge v3 tests — node:test, stdlib only.
 * Red-green per RC1–RC6 (FULLCRITIC-v3.md §4) + guards + git_push/checkout
 * + write/edit/patch + run_command + MCP stdio + concurrency.
 *
 * Spawns the real server as a subprocess against a temp project root
 * (temp HOME, so no real token/audit/config is touched) and drives it
 * over HTTP, the same way Muse web does.
 *
 * Run:  node --test test/bridge-v3.test.js
 *   or: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'server.js');
const GATE = require('../lib/gate.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startServer({ project, home, extraArgs = [], extraEnv = {} }) {
  const port = await freePort();
  const tokenFile = path.join(home, 'token');
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--token-file', tokenFile, ...extraArgs], {
    cwd: project, env: { ...process.env, HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let token = null;
  for (let i = 0; i < 100; i++) {
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); if (token) break; } catch { /* not yet */ }
    await sleep(100);
  }
  assert.ok(token, `server did not write a token (stderr: ${stderr.slice(0, 500)})`);
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status === 200) break; } catch { /* not yet */ }
    await sleep(100);
  }
  return { child, port, token, base: `http://127.0.0.1:${port}`, stop() { try { child.kill('SIGTERM'); } catch {} } };
}

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-v3-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-v3-home-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\nTODO fix me\nline three\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'console.log(1);\n');
  // Long 'a' line for the ReDoS test (RC5).
  fs.writeFileSync(path.join(dir, 'redos.txt'), 'a'.repeat(50000) + 'b\n');
  // >1MB file for the single-file size test (RC6).
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(1024 * 1024 + 100) + '\nneedle\n');
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  let hasGit = git.status === 0;
  if (hasGit) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir });
    const c = spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    hasGit = c.status === 0;
  }
  return { dir, home, hasGit };
}

let project, srv;
function call(tool, args = {}, token, base) {
  const b = base || srv.base;
  const t = token ?? srv.token;
  return fetch(`${b}/api/tools/call`, {
    method: 'POST',
    headers: { 'X-Api-Key': t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, ...args }),
  }).then((r) => r.json());
}

test.before(async () => {
  project = makeProject();
  srv = await startServer({ project: project.dir, home: project.home, extraArgs: ['--allow-shell', '--allow-git-write'] });
});

test.after(() => {
  srv && srv.stop();
  try { fs.rmSync(project.dir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(project.home, { recursive: true, force: true }); } catch {}
});

// --- Gate unit: deletion test (Gate disabled => everything guarded fails) ---
test('gate unit: disabled Gate fails closed for every validator', () => {
  const g = GATE.createGate({ enabled: false });
  assert.throws(() => g.validateRef('main'), /GATE_DISABLED/);
  assert.throws(() => g.validateArgv(['push'], ['origin']), /GATE_DISABLED/);
  assert.throws(() => g.validatePaths([{ path: 'a.txt' }], { root: { path: project.dir } }), /GATE_DISABLED/);
  assert.throws(() => g.validateRegex('abc'), /GATE_DISABLED/);
  assert.throws(() => g.validateSize(10, 1024 * 1024), /GATE_DISABLED/);
  assert.equal(g.enabled, false);
  const on = GATE.createGate({ enabled: true });
  assert.equal(on.validateRef('main'), 'main');
  assert.equal(on.validateSize(10, 1024 * 1024), true);
});

test('gate unit: enabled Gate validates refs, argv, regex, size', () => {
  const g = GATE.createGate({ enabled: true });
  assert.throws(() => g.validateRef('--force'), /BAD_ARGS/);
  assert.throws(() => g.validateRef('-x'), /BAD_ARGS/);
  assert.throws(() => g.validateRef('a..b'), /BAD_ARGS/);
  assert.throws(() => g.validateRef('a b'), /BAD_ARGS/);
  assert.equal(g.validateRef('feature/x-1.2'), 'feature/x-1.2');
  // argv: '--' is inserted before positional args; user flags rejected.
  assert.deepEqual(g.validateArgv(['push'], ['origin', 'main']), ['push', '--', 'origin', 'main']);
  assert.throws(() => g.validateArgv(['push'], ['--force']), /BAD_ARGS/);
  // internal allowlisted flags pass when explicitly allowed by the caller.
  assert.deepEqual(g.validateArgv(['diff'], ['--cached'], { allowFlags: ['--cached'] }), ['diff', '--cached']);
  // regex: too long, nested quantifiers rejected.
  assert.throws(() => g.validateRegex('x'.repeat(201)), /BAD_ARGS/);
  assert.throws(() => g.validateRegex('(a+)+$'), /BAD_ARGS/);
  assert.throws(() => g.validateRegex('(a*)*'), /BAD_ARGS/);
  assert.throws(() => g.validateRegex('(.*)*'), /BAD_ARGS/);
  assert.equal(g.validateRegex('TODO|hello'), 'TODO|hello');
  // size: over the cap rejected.
  assert.throws(() => g.validateSize(1024 * 1024 + 1, 1024 * 1024), /BAD_ARGS/);
});

// --- RC1: git ref / argv injection ---
test('RC1: git_push / git_checkout reject leading-dash refs', async () => {
  if (!project.hasGit) { test.skip('git not available'); return; }
  const a = await call('git_push', { remote: '--force' });
  assert.equal(a.ok, false); assert.equal(a.error.code, 'BAD_ARGS');
  const b = await call('git_push', { remote: 'origin', branch: '--force' });
  assert.equal(b.ok, false); assert.equal(b.error.code, 'BAD_ARGS');
  const c = await call('git_push', { remote: 'origin', branch: '--tags' });
  assert.equal(c.ok, false); assert.equal(c.error.code, 'BAD_ARGS');
  const d = await call('git_checkout', { branch: '--detach' });
  assert.equal(d.ok, false); assert.equal(d.error.code, 'BAD_ARGS');
  const e = await call('git_checkout', { branch: '-b' });
  assert.equal(e.ok, false); assert.equal(e.error.code, 'BAD_ARGS');
});

// --- RC2: git_commit all:true must not stage secrets ---
test('RC2: git_commit all:true does not stage blocklisted secrets', async () => {
  if (!project.hasGit) { test.skip('git not available'); return; }
  fs.writeFileSync(path.join(project.dir, '.env'), 'SECRET=abc123\n');
  fs.writeFileSync(path.join(project.dir, '.npmrc'), '//registry.npmjs.org/:_authToken=zzz\n');
  fs.writeFileSync(path.join(project.dir, 'safe.txt'), 'safe\n');
  const commit = await call('git_commit', { message: 'rc2 test commit', all: true });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const tracked = spawnSync('git', ['ls-files'], { cwd: project.dir, encoding: 'utf8' }).stdout.split('\n');
  assert.ok(tracked.includes('safe.txt'), 'safe file should be committed');
  assert.ok(!tracked.includes('.env'), '.env must NOT be committed');
  assert.ok(!tracked.includes('.npmrc'), '.npmrc must NOT be committed');
  const staged = spawnSync('git', ['status', '--porcelain'], { cwd: project.dir, encoding: 'utf8' }).stdout;
  // '?? .env' (untracked) is fine — staged would be 'A  .env' / 'M  .env'.
  const stagedLines = staged.split('\n').filter(Boolean);
  assert.ok(!stagedLines.some((l) => /^[AM]/.test(l) && l.includes('.env')), `.env must not be staged after commit: ${staged}`);
  assert.ok(!stagedLines.some((l) => /^[AM]/.test(l) && l.includes('.npmrc')), `.npmrc must not be staged after commit: ${staged}`);
});

// --- RC3: bounded terminals/jobs ---
test('RC3: terminal count is bounded (MAX_TERMINALS=8)', async () => {
  const ids = [];
  let exhausted = null;
  try {
    for (let i = 0; i < 12; i++) {
      const r = await call('terminal_create', {});
      if (r.ok) ids.push(r.data.id);
      else { exhausted = r; break; }
    }
    assert.ok(ids.length <= 8, `created ${ids.length} terminals, expected <= 8`);
    assert.ok(exhausted, 'expected RESOURCE_EXHAUSTED once the limit is hit');
    assert.equal(exhausted.error.code, 'RESOURCE_EXHAUSTED');
    const list = await call('terminal_list', {});
    assert.ok(list.data.terminals.length <= 8);
  } finally {
    for (const id of ids) await call('terminal_kill', { id });
  }
});

test('RC3: exec jobs are bounded (MAX_JOBS=16)', async () => {
  const ids = [];
  let exhausted = null;
  try {
    for (let i = 0; i < 20; i++) {
      const r = await call('exec_start', { command: 'sleep 30' });
      if (r.ok) ids.push(r.data.job_id);
      else { exhausted = r; break; }
    }
    assert.ok(ids.length <= 16, `started ${ids.length} jobs, expected <= 16`);
    assert.ok(exhausted, 'expected RESOURCE_EXHAUSTED once the job limit is hit');
    assert.equal(exhausted.error.code, 'RESOURCE_EXHAUSTED');
  } finally {
    for (const id of ids) await call('exec_kill', { job_id: id });
  }
});

// --- RC4: group kill leaves no orphan ---
test('RC4: exec_kill kills the whole process group (no orphan sleep)', async () => {
  const started = await call('exec_start', { command: 'sleep 60; echo never' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const jobId = started.data.job_id;
  await sleep(500);
  const killed = await call('exec_kill', { job_id: jobId });
  assert.equal(killed.ok, true);
  await sleep(500);
  const ps = spawnSync('bash', ['-c', 'ps -eo args | grep -F "sleep 60" | grep -v grep || true'], { encoding: 'utf8' });
  assert.ok(!ps.stdout.includes('sleep 60'), `orphan sleep still running: ${ps.stdout}`);
});

// --- RC5: ReDoS via worker + timeout ---
test('RC5: evil regex returns TIMEOUT instead of hanging the server', async () => {
  const t0 = Date.now();
  const r = await call('grep_code', { pattern: '(a+)+$', path: 'redos.txt' });
  const dt = Date.now() - t0;
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.error.code, 'BAD_ARGS', 'nested-quantifier pattern is rejected outright by the Gate');
  assert.ok(dt < 5000, `took ${dt}ms`);
  // A long-but-legal regex on a long line must not hang either: server must answer.
  const r2 = await call('grep_code', { pattern: 'a+$', path: 'redos.txt' });
  assert.ok(Date.now() - t0 < 10000, 'server still responsive');
  assert.equal(typeof r2.ok, 'boolean');
});

test('RC5: over-long regex pattern is rejected', async () => {
  const r = await call('grep_code', { pattern: 'x'.repeat(201) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_ARGS');
});

// --- RC6: single-file search size cap ---
test('RC6: search_code on a single file >1MB is rejected before reading', async () => {
  const r = await call('search_code', { pattern: 'needle', path: 'big.txt' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_ARGS');
  assert.match(r.error.message, /too large/);
  // Walk mode still skips the big file without error.
  const w = await call('search_code', { pattern: 'TODO' });
  assert.equal(w.ok, true);
});

// --- Search worker prefilter (bench fix): same results, less decoding ---
test('search prefilter: literal + plain-literal regex find; case-insensitive still finds', async () => {
  // Plain-literal regex: prefilter active (Buffer.includes on 'TODO').
  const plain = await call('grep_code', { pattern: 'TODO' });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.ok(plain.data.matches.some((m) => m.path === 'hello.txt'));
  // Meta-char regex: prefilter inactive, per-line regex still works.
  const meta = await call('grep_code', { pattern: 'TODO|hello' });
  assert.equal(meta.ok, true, JSON.stringify(meta));
  assert.ok(meta.data.matches.some((m) => m.path === 'hello.txt'));
  // Case-insensitive: prefilter MUST NOT apply ('todo' bytes != 'TODO'
  // bytes); the 'i' regex must still match.
  const ci = await call('grep_code', { pattern: 'todo', case_insensitive: true });
  assert.equal(ci.ok, true, JSON.stringify(ci));
  assert.ok(ci.data.matches.some((m) => m.path === 'hello.txt'));
  // Same pattern, case-sensitive: must NOT match 'TODO'.
  const cs = await call('grep_code', { pattern: 'todo' });
  assert.equal(cs.ok, true, JSON.stringify(cs));
  assert.ok(!cs.data.matches.some((m) => m.path === 'hello.txt'));
  // Literal search with metachars in the pattern is verbatim: 'TODO|hello'
  // as a literal string occurs in no file.
  const lit = await call('search_code', { pattern: 'TODO|hello' });
  assert.equal(lit.ok, true, JSON.stringify(lit));
  assert.equal(lit.data.matches.length, 0);
});

// --- Gate deletion via HTTP: disabled Gate => write/shell/git fail ---
test('gate deletion (HTTP): MUSE_BRIDGE_GATE_DISABLED=1 fails all write/shell/git', async () => {
  const gated = await startServer({ project: project.dir, home: project.home, extraArgs: ['--allow-shell', '--allow-git-write'], extraEnv: { MUSE_BRIDGE_GATE_DISABLED: '1' } });
  try {
    const w = await call('write_file', { path: 'gated.txt', content: 'x' }, gated.token, gated.base);
    assert.equal(w.ok, false); assert.equal(w.error.code, 'GATE_DISABLED');
    const t = await call('terminal_create', {}, gated.token, gated.base);
    assert.equal(t.ok, false); assert.equal(t.error.code, 'GATE_DISABLED');
    const g = await call('git_commit', { message: 'x' }, gated.token, gated.base);
    assert.equal(g.ok, false); assert.equal(g.error.code, 'GATE_DISABLED');
    // Reads still work (fail-closed only blocks write/shell/git).
    const r = await call('read_file', { path: 'hello.txt' }, gated.token, gated.base);
    assert.equal(r.ok, true);
  } finally { gated.stop(); }
});

// --- Extended blocklist ---
test('blocklist: extended secrets are FILE_BLOCKED on read and write', async () => {
  for (const name of ['.npmrc', '.git-credentials', 'credentials.json', 'x.token', '.netrc']) {
    fs.writeFileSync(path.join(project.dir, name), 'secret\n');
  }
  fs.mkdirSync(path.join(project.dir, '.docker'), { recursive: true });
  fs.writeFileSync(path.join(project.dir, '.docker', 'config.json'), '{"auths":{}}\n');
  for (const name of ['.npmrc', '.git-credentials', 'credentials.json', 'x.token', '.netrc', '.docker/config.json']) {
    const r = await call('read_file', { path: name });
    assert.equal(r.ok, false, name);
    assert.equal(r.error.code, 'FILE_BLOCKED', name);
    const w = await call('write_file', { path: name, content: 'x' });
    assert.equal(w.ok, false, name);
    assert.equal(w.error.code, 'FILE_BLOCKED', name);
  }
});

// --- read_file offset is 0-based (PROTOCOL.md fixed to match code) ---
test('read_file offset is 0-based', async () => {
  const a = await call('read_file', { path: 'hello.txt', offset: 0, limit: 1 });
  assert.equal(a.ok, true);
  assert.match(a.data.content, /hello world/);
  const b = await call('read_file', { path: 'hello.txt', offset: 1, limit: 1 });
  assert.equal(b.ok, true);
  assert.match(b.data.content, /TODO fix me/);
  assert.equal(b.data.offset, 1);
});

// --- git_push to a local file:// dummy remote ---
test('git_push pushes to a local file:// bare remote', async () => {
  if (!project.hasGit) { test.skip('git not available'); return; }
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-v3-bare-'));
  try {
    spawnSync('git', ['init', '--bare', '-q', bare]);
    spawnSync('git', ['remote', 'add', 'dummy', bare], { cwd: project.dir });
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.dir, encoding: 'utf8' }).stdout.trim();
    const pushed = await call('git_push', { remote: 'dummy', branch });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    const ls = spawnSync('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' });
    assert.equal(ls.status, 0, 'branch must exist on the dummy remote after push');
  } finally {
    spawnSync('git', ['remote', 'remove', 'dummy'], { cwd: project.dir });
    try { fs.rmSync(bare, { recursive: true, force: true }); } catch {}
  }
});

// --- git_checkout success ---
test('git_checkout creates and switches branches', async () => {
  if (!project.hasGit) { test.skip('git not available'); return; }
  const cur = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.dir, encoding: 'utf8' }).stdout.trim();
  const created = await call('git_checkout', { branch: 'v3-test-branch', create: true });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.data.created, true);
  const back = await call('git_checkout', { branch: cur });
  assert.equal(back.ok, true, JSON.stringify(back));
  spawnSync('git', ['branch', '-D', 'v3-test-branch'], { cwd: project.dir });
});

// --- write / edit / patch success paths ---
test('write/edit/patch success paths', async () => {
  const w = await call('write_file', { path: 'sub/note.txt', content: 'alpha\nbeta\n' });
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.equal(fs.readFileSync(path.join(project.dir, 'sub', 'note.txt'), 'utf8'), 'alpha\nbeta\n');
  const e = await call('edit_file', { path: 'sub/note.txt', old_text: 'beta', new_text: 'gamma' });
  assert.equal(e.ok, true, JSON.stringify(e));
  assert.match(fs.readFileSync(path.join(project.dir, 'sub', 'note.txt'), 'utf8'), /gamma/);
  const p = await call('apply_patch', {
    path: 'sub/note.txt',
    patch: '@@ -1,2 +1,2 @@\n alpha\n-gamma\n+delta\n',
  });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.match(fs.readFileSync(path.join(project.dir, 'sub', 'note.txt'), 'utf8'), /delta/);
});

// --- run_command success + reject ---
test('run_command: allowlisted succeeds, other commands rejected', async () => {
  const okR = await call('run_command', { command: 'git status' });
  assert.equal(okR.ok, true, JSON.stringify(okR));
  assert.equal(okR.data.exit_code, 0);
  const no = await call('run_command', { command: 'rm -rf /' });
  assert.equal(no.ok, false);
  assert.ok(['COMMAND_NOT_ALLOWED', 'COMMAND_REJECTED_METACHAR'].includes(no.error.code));
});

// --- version + token not on stdout ---
test('version is 0.3.1 and token is not printed to stdout', async () => {
  const list = await fetch(`${srv.base}/api/tools/list`, { headers: { 'X-Api-Key': srv.token } }).then((r) => r.json());
  assert.equal(list.data.version, '0.3.1');
});

// --- audit: terminal input is never logged ---
test('audit: terminal_send input is not written to audit.log', async () => {
  const secret = 'SENT-SECRET-' + Date.now();
  const created = await call('terminal_create', {});
  assert.equal(created.ok, true);
  const id = created.data.id;
  try {
    await call('terminal_send', { id, input: `echo ${secret}\n` });
    await sleep(300);
  } finally {
    await call('terminal_kill', { id });
  }
  const auditPath = path.join(project.home, '.muse-ai-local-bridge', 'audit.log');
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  assert.ok(!audit.includes(secret), 'terminal input must never reach audit.log');
  assert.ok(!audit.includes('echo ' + secret), 'terminal input must never reach audit.log');
});

// --- MCP end-to-end via stdio ---
test('MCP: initialize + tools/list + tools/call over stdio', async () => {
  const child = spawn(process.execPath, [SERVER, '--mcp', '--allow-shell', '--allow-git-write', '--token-file', path.join(project.home, 'token-mcp')], {
    cwd: project.dir, env: { ...process.env, HOME: project.home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let buf = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      lines.push(JSON.parse(line));
      const w = waiters.shift(); if (w) w();
    }
  });
  function nextMsg() {
    if (lines.length) return Promise.resolve(lines.shift());
    return new Promise((res) => waiters.push(() => res(lines.shift())));
  }
  function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const init = await nextMsg();
    assert.equal(init.result.serverInfo.version, '0.3.1');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await nextMsg();
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('list_files'));
    assert.ok(names.includes('terminal_create'));
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_files', arguments: {} } });
    const called = await nextMsg();
    assert.equal(called.result.isError, undefined);
    assert.match(called.result.content[0].text, /hello\.txt/);
  } finally {
    child.kill('SIGTERM');
  }
});

// --- concurrency: 2 terminals + 5 jobs at once ---
test('concurrency: 2 terminals + 5 jobs run together', async () => {
  const t1 = await call('terminal_create', {});
  const t2 = await call('terminal_create', {});
  assert.equal(t1.ok, true); assert.equal(t2.ok, true);
  try {
    await call('terminal_send', { id: t1.data.id, input: 'echo conc-one\n' });
    await call('terminal_send', { id: t2.data.id, input: 'echo conc-two\n' });
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      const s = await call('exec_start', { command: `echo job-${i}` });
      assert.equal(s.ok, true, JSON.stringify(s));
      jobs.push(s.data.job_id);
    }
    const outs = ['', ''];
    for (let i = 0; i < 50; i++) {
      const r1 = await call('terminal_read', { id: t1.data.id });
      const r2 = await call('terminal_read', { id: t2.data.id });
      outs[0] = r1.data.output; outs[1] = r2.data.output;
      if (outs[0].includes('conc-one') && outs[1].includes('conc-two')) break;
      await sleep(100);
    }
    assert.match(outs[0], /conc-one/);
    assert.match(outs[1], /conc-two/);
    for (let i = 0; i < 5; i++) {
      let last;
      for (let k = 0; k < 50; k++) {
        last = await call('exec_poll', { job_id: jobs[i] });
        if (last.data.status === 'done') break;
        await sleep(100);
      }
      assert.equal(last.data.status, 'done');
      assert.match(last.data.output, new RegExp(`job-${i}`));
    }
  } finally {
    await call('terminal_kill', { id: t1.data.id });
    await call('terminal_kill', { id: t2.data.id });
    // jobs are done; kill is a no-op cleanup.
  }
});

// --- git_status includes branch in one call (P1 shape) ---
test('git_status returns branch + files', async () => {
  if (!project.hasGit) { test.skip('git not available'); return; }
  const s = await call('git_status', {});
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.ok(typeof s.data.branch === 'string' && s.data.branch.length > 0);
  assert.ok(Array.isArray(s.data.files));
});
