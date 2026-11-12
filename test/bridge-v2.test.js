'use strict';
/**
 * bridge v2 tests — node:test, stdlib only.
 * Spawns the real server as a subprocess against a temp project root
 * (temp HOME, so no real token/audit/config is touched) and drives it
 * over HTTP, the same way Muse web does.
 *
 * Run:  node --test test/bridge-v2.test.js
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

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startServer({ project, home, extraArgs = [] }) {
  const port = await freePort();
  const tokenFile = path.join(home, 'token');
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--token-file', tokenFile, ...extraArgs], {
    cwd: project, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  // Wait for the token file + a responding server (max ~10s).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-v2-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-v2-home-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'local'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\nTODO fix me\n');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), '# Demo\n\nA demo skill for testing.\n');
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'local', 'SKILL.md'), '---\ndescription: Local test skill\n---\n# Local\n\nDoes local things.\n');
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
function call(tool, args = {}, token) {
  return fetch(`${srv.base}/api/tools/call`, {
    method: 'POST',
    headers: { 'X-Api-Key': token ?? srv.token, 'Content-Type': 'application/json' },
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

test('auth: no token and wrong token are rejected with 401', async () => {
  const noToken = await fetch(`${srv.base}/api/tools/list`);
  assert.equal(noToken.status, 401);
  const bad = await fetch(`${srv.base}/api/tools/list`, { headers: { 'X-Api-Key': 'nope' } });
  assert.equal(bad.status, 401);
  const good = await fetch(`${srv.base}/api/tools/list`, { headers: { 'X-Api-Key': srv.token } });
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.equal(body.data.version, '0.3.0');
  assert.equal(body.data.shell_enabled, true);
});

test('scope guard: paths outside the root are rejected', async () => {
  const a = await call('read_file', { path: '../../etc/passwd' });
  assert.equal(a.ok, false);
  assert.equal(a.error.code, 'PATH_OUTSIDE_ROOT');
  const b = await call('read_file', { path: '/etc/passwd' });
  assert.equal(b.ok, false);
  assert.equal(b.error.code, 'PATH_OUTSIDE_ROOT');
});

test('v1 tools still work: list_files / read_file / search_code', async () => {
  const files = await call('list_files', {});
  assert.equal(files.ok, true);
  assert.ok(files.data.files.some((f) => f.path === 'hello.txt'));
  const read = await call('read_file', { path: 'hello.txt' });
  assert.equal(read.ok, true);
  assert.match(read.data.content, /hello world/);
  const search = await call('search_code', { pattern: 'TODO' });
  assert.equal(search.ok, true);
  assert.equal(search.data.matches[0].path, 'hello.txt');
});

test('terminal: create + send + read returns the echo', async () => {
  const created = await call('terminal_create', {});
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.data.id;
  try {
    const sent = await call('terminal_send', { id, input: 'echo hello-v2\n' });
    assert.equal(sent.ok, true);
    let out = '';
    for (let i = 0; i < 50; i++) {
      const r = await call('terminal_read', { id });
      assert.equal(r.ok, true);
      out = r.data.output;
      if (out.includes('hello-v2')) break;
      await sleep(100);
    }
    assert.match(out, /hello-v2/);
  } finally {
    await call('terminal_kill', { id });
  }
});

test('exec: start + poll reaches done with exit 0', async () => {
  const started = await call('exec_start', { command: 'sleep 1; echo job-done' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const jobId = started.data.job_id;
  let last;
  for (let i = 0; i < 50; i++) {
    last = await call('exec_poll', { job_id: jobId });
    assert.equal(last.ok, true);
    if (last.data.status === 'done') break;
    await sleep(100);
  }
  assert.equal(last.data.status, 'done');
  assert.equal(last.data.exit_code, 0);
  assert.match(last.data.output, /job-done/);
});

test('glob + grep: glob finds src/a.js, regex grep finds TODO', async () => {
  const glob = await call('glob_files', { pattern: '**/*.js' });
  assert.equal(glob.ok, true);
  assert.deepEqual(glob.data.files, ['src/a.js']);
  const grep = await call('grep_code', { pattern: 'TODO|hello' });
  assert.equal(grep.ok, true);
  assert.ok(grep.data.matches.some((m) => m.path === 'hello.txt'));
  const badRe = await call('grep_code', { pattern: '([invalid' });
  assert.equal(badRe.ok, false);
  assert.equal(badRe.error.code, 'BAD_ARGS');
});

test('skill loader: list_skills finds the example skill, read_skill reads it', async () => {
  const list = await call('list_skills', {});
  assert.equal(list.ok, true);
  const names = list.data.skills.map((s) => s.name);
  assert.ok(names.includes('demo'), `skills: ${names.join(',')}`);
  assert.ok(names.includes('local'));
  const read = await call('read_skill', { name: 'demo' });
  assert.equal(read.ok, true);
  assert.match(read.data.content, /A demo skill for testing/);
  const missing = await call('read_skill', { name: 'no-such-skill' });
  assert.equal(missing.ok, false);
});

test('git: branch lists the repo branch; commit creates a commit (when git exists)', async () => {
  if (!project.hasGit) { test.skip('git not available'); return; }
  const branch = await call('git_branch', {});
  assert.equal(branch.ok, true);
  assert.ok(branch.data.branches.length >= 1);
  fs.writeFileSync(path.join(project.dir, 'v2.txt'), 'v2\n');
  const commit = await call('git_commit', { message: 'v2 test commit', all: true });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.match(commit.data.commit, /^[0-9a-f]{40}$/);
  const log = await call('git_log', { limit: 2 });
  assert.equal(log.data.commits[0].subject, 'v2 test commit');
});

test('guards: without --allow-shell / --allow-git-write the v2 write tools refuse', async () => {
  const plain = await startServer({ project: project.dir, home: project.home, extraArgs: [] });
  try {
    const t = await fetch(`${plain.base}/api/tools/call`, {
      method: 'POST', headers: { 'X-Api-Key': plain.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'terminal_create' }),
    }).then((r) => r.json());
    assert.equal(t.ok, false);
    assert.equal(t.error.code, 'SHELL_NOT_ENABLED');
    const g = await fetch(`${plain.base}/api/tools/call`, {
      method: 'POST', headers: { 'X-Api-Key': plain.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'git_commit', message: 'x' }),
    }).then((r) => r.json());
    assert.equal(g.ok, false);
    assert.equal(g.error.code, 'GIT_WRITE_NOT_ALLOWED');
    // …but plain reads still work on the guarded server.
    const r = await fetch(`${plain.base}/api/tools/call`, {
      method: 'POST', headers: { 'X-Api-Key': plain.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'read_file', path: 'hello.txt' }),
    }).then((x) => x.json());
    assert.equal(r.ok, true);
  } finally { plain.stop(); }
});

test('read-only: write_file is refused with MODE_READ_ONLY', async () => {
  const ro = await startServer({ project: project.dir, home: project.home, extraArgs: ['--read-only'] });
  try {
    const w = await fetch(`${ro.base}/api/tools/call`, {
      method: 'POST', headers: { 'X-Api-Key': ro.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'write_file', path: 'nope.txt', content: 'x' }),
    }).then((r) => r.json());
    assert.equal(w.ok, false);
    assert.equal(w.error.code, 'MODE_READ_ONLY');
  } finally { ro.stop(); }
});
