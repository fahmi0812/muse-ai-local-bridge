'use strict';
/**
 * bridge v0.3.1 tests — node:test, stdlib only.
 *
 * `mbridge code [folder]` and `mbridge setup` (ease of use only):
 * - code enables shell + git-write, scoped to the folder (or cwd)
 * - setup merges allow_shell/allow_git_write into config.json,
 *   keeps existing roots, never touches the token, idempotent
 * - plain `mbridge` without setup/code stays allowlist-only (v3.0
 *   default unchanged); --read-only still wins over code
 *
 * Spawns the real server as a subprocess against temp project roots
 * (temp HOME, so no real token/audit/config is touched).
 *
 * Run:  node --test test/bridge-v3.1.test.js
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
function mkTemp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

async function startServer({ project, home, extraArgs = [] }) {
  const port = await freePort();
  const tokenFile = path.join(home, 'token');
  const child = spawn(process.execPath, [SERVER, ...extraArgs, '--port', String(port), '--token-file', tokenFile], {
    cwd: project, env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
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
  return { child, port, token, base: `http://127.0.0.1:${port}`, stderr, stop() { try { child.kill('SIGTERM'); } catch {} } };
}

async function toolsList(base, token) {
  const r = await fetch(`${base}/api/tools/list`, { headers: { 'X-Api-Key': token } });
  return r.json();
}
async function call(tool, args, token, base) {
  return fetch(`${base}/api/tools/call`, {
    method: 'POST',
    headers: { 'X-Api-Key': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, ...args }),
  }).then((r) => r.json());
}

test('code --help mentions code and setup', () => {
  const r = spawnSync(process.execPath, [SERVER, 'code', '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /code \[folder\]/);
  assert.match(r.stdout, /setup/);
  assert.match(r.stdout, /ready-to-code/);
});

test('code enables shell + git-write and terminal_create works', async () => {
  const project = mkTemp('bridge-31-proj-');
  const home = mkTemp('bridge-31-home-');
  fs.writeFileSync(path.join(project, 'hello.txt'), 'hi\n');
  const srv = await startServer({ project, home, extraArgs: ['code'] });
  try {
    const list = await toolsList(srv.base, srv.token);
    assert.equal(list.data.shell_enabled, true);
    assert.equal(list.data.git_write_enabled, true);
    const names = list.data.tools.map((t) => t.name);
    assert.ok(names.includes('terminal_create'), 'terminal_create must be listed in code mode');
    assert.ok(names.includes('git_commit'), 'git_commit must be listed in code mode');
    const t = await call('terminal_create', {}, srv.token, srv.base);
    assert.equal(t.ok, true, JSON.stringify(t));
    await call('terminal_kill', { id: t.data.id }, srv.token, srv.base);
    assert.match(srv.stderr, /CODE MODE/);
  } finally {
    srv.stop();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('code <folder> scopes the server to that folder from elsewhere', async () => {
  const project = mkTemp('bridge-31-proj-');
  const elsewhere = mkTemp('bridge-31-else-');
  const home = mkTemp('bridge-31-home-');
  fs.writeFileSync(path.join(project, 'hello.txt'), 'hi\n');
  const srv = await startServer({ project: elsewhere, home, extraArgs: ['code', project] });
  try {
    const list = await toolsList(srv.base, srv.token);
    assert.equal(list.data.shell_enabled, true);
    assert.deepEqual(list.data.project_roots, [fs.realpathSync(project)]);
    const files = await call('list_files', {}, srv.token, srv.base);
    assert.equal(files.ok, true, JSON.stringify(files));
    assert.ok(files.data.files.some((f) => f.path === 'hello.txt'));
  } finally {
    srv.stop();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('code --read-only wins: shell and git-write stay off', async () => {
  const project = mkTemp('bridge-31-proj-');
  const home = mkTemp('bridge-31-home-');
  const srv = await startServer({ project, home, extraArgs: ['code', '--read-only'] });
  try {
    const list = await toolsList(srv.base, srv.token);
    assert.equal(list.data.mode, 'read-only');
    assert.equal(list.data.shell_enabled, false);
    assert.equal(list.data.git_write_enabled, false);
    const t = await call('terminal_create', {}, srv.token, srv.base);
    assert.equal(t.ok, false);
  } finally {
    srv.stop();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup merges config, keeps roots, never touches the token, idempotent', () => {
  const project = mkTemp('bridge-31-proj-');
  const home = mkTemp('bridge-31-home-');
  const cfgDir = path.join(home, '.muse-ai-local-bridge');
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.mkdirSync(cfgDir, { recursive: true });
  // Pre-seed: one root + shell explicitly off + an unrelated key.
  fs.writeFileSync(cfgPath, JSON.stringify({ roots: [project], allow_shell: false, custom_note: 'keep-me' }, null, 2));
  const run = () => spawnSync(process.execPath, [SERVER, 'setup'], { cwd: project, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  try {
    const r1 = run();
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /setup done/);
    assert.match(r1.stdout, /cloudflared/);
    const cfg1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(cfg1.allow_shell, true);
    assert.equal(cfg1.allow_git_write, true);
    assert.deepEqual(cfg1.roots, [project], 'existing roots must be kept');
    assert.equal(cfg1.custom_note, 'keep-me', 'other keys must be kept');
    assert.ok(!fs.existsSync(path.join(cfgDir, 'token')), 'setup must not create a token file');
    const before = fs.readFileSync(cfgPath, 'utf8');
    const r2 = run();
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /already set up/);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), before, 'second setup must not change the file');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup from scratch creates config with both flags on', () => {
  const project = mkTemp('bridge-31-proj-');
  const home = mkTemp('bridge-31-home-');
  try {
    const r = spawnSync(process.execPath, [SERVER, 'setup'], { cwd: project, env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /setup done/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.muse-ai-local-bridge', 'config.json'), 'utf8'));
    assert.equal(cfg.allow_shell, true);
    assert.equal(cfg.allow_git_write, true);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plain mbridge without setup stays allowlist-only (default unchanged)', async () => {
  const project = mkTemp('bridge-31-proj-');
  const home = mkTemp('bridge-31-home-');
  const srv = await startServer({ project, home, extraArgs: [] });
  try {
    const list = await toolsList(srv.base, srv.token);
    assert.equal(list.data.shell_enabled, false);
    assert.equal(list.data.git_write_enabled, false);
    const names = list.data.tools.map((t) => t.name);
    assert.ok(!names.includes('terminal_create'), 'terminal_create must NOT be listed by default');
    assert.ok(!names.includes('git_commit'), 'git_commit must NOT be listed by default');
    const t = await call('terminal_create', {}, srv.token, srv.base);
    assert.equal(t.ok, false);
    assert.equal(t.error.code, 'SHELL_NOT_ENABLED');
  } finally {
    srv.stop();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('plain mbridge after setup is ready-to-code mode', async () => {
  const project = mkTemp('bridge-31-proj-');
  const home = mkTemp('bridge-31-home-');
  const s = spawnSync(process.execPath, [SERVER, 'setup'], { cwd: project, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  const srv = await startServer({ project, home, extraArgs: [] });
  try {
    const list = await toolsList(srv.base, srv.token);
    assert.equal(list.data.shell_enabled, true);
    assert.equal(list.data.git_write_enabled, true);
    const t = await call('terminal_create', {}, srv.token, srv.base);
    assert.equal(t.ok, true, JSON.stringify(t));
    await call('terminal_kill', { id: t.data.id }, srv.token, srv.base);
  } finally {
    srv.stop();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
