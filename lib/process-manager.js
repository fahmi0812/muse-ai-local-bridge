'use strict';
/**
 * lib/process-manager.js — ProcessManager v3 (RC3 + RC4).
 * Bounded terminals/jobs, LRU eviction of finished ones, idle TTL,
 * process-GROUP kill (spawn detached:true + kill(-pid, SIGKILL)).
 *
 * Limits via env: MUSE_BRIDGE_MAX_TERMINALS (default 8),
 * MUSE_BRIDGE_MAX_JOBS (default 16). TTLs via env (ms) for tests:
 * MUSE_BRIDGE_TERMINAL_IDLE_MS (default 30 min),
 * MUSE_BRIDGE_JOB_DONE_TTL_MS (default 10 min).
 */
const { spawn } = require('node:child_process');

const DEFAULT_MAX_TERMINALS = 8;
const DEFAULT_MAX_JOBS = 16;
const DEFAULT_TERMINAL_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_JOB_DONE_TTL_MS = 10 * 60 * 1000;

function envInt(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

class ResourceExhaustedError extends Error {
  constructor(what) { super(`RESOURCE_EXHAUSTED: too many ${what}`); this.code = 'RESOURCE_EXHAUSTED'; }
}

/** Kill a whole process group; fall back to the child PID alone. */
function killGroup(child, signal = 'SIGKILL') {
  if (!child || child.killed) return false;
  const pid = child.pid;
  if (!pid) return false;
  try {
    // Negative pid = process group (child was spawned detached:true).
    process.kill(-pid, signal);
    return true;
  } catch {
    try { child.kill(signal); return true; } catch { return false; }
  }
}

class ProcessManager {
  constructor({ maxTerminals, maxJobs, terminalIdleMs, jobDoneTtlMs } = {}) {
    this.maxTerminals = maxTerminals ?? envInt('MUSE_BRIDGE_MAX_TERMINALS', DEFAULT_MAX_TERMINALS);
    this.maxJobs = maxJobs ?? envInt('MUSE_BRIDGE_MAX_JOBS', DEFAULT_MAX_JOBS);
    this.terminalIdleMs = terminalIdleMs ?? envInt('MUSE_BRIDGE_TERMINAL_IDLE_MS', DEFAULT_TERMINAL_IDLE_MS);
    this.jobDoneTtlMs = jobDoneTtlMs ?? envInt('MUSE_BRIDGE_JOB_DONE_TTL_MS', DEFAULT_JOB_DONE_TTL_MS);
    this.terminals = new Map(); // id -> term
    this.jobs = new Map();      // id -> job
    this._termSeq = 0;
    this._jobSeq = 0;
    this._sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  /** Remove finished jobs past TTL and idle/exited terminals. */
  sweep(now = Date.now()) {
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && now - (job.finishedAt || job.startedAtMs) > this.jobDoneTtlMs) {
        this.jobs.delete(id);
      }
    }
    for (const [id, t] of this.terminals) {
      const idleFor = now - (t.lastActivityMs || t.createdAtMs);
      if (t.exitCode !== null || idleFor > this.terminalIdleMs) {
        this.killTerminal(id, 'SIGKILL');
      }
    }
  }

  _evictFinished(map, max) {
    // LRU: drop finished/exited entries first (oldest first).
    if (map.size < max) return true;
    const finished = [...map.entries()].filter(([, v]) => v.exitCode !== null || (v.status && v.status !== 'running'));
    finished.sort((a, b) => (a[1].finishedAt || a[1].createdAtMs || 0) - (b[1].finishedAt || b[1].createdAtMs || 0));
    for (const [id] of finished) {
      if (map.size < max) break;
      map.delete(id);
    }
    return map.size < max;
  }

  // --- terminals ---
  createTerminal({ cwd, env }) {
    this.sweep();
    if (!this._evictFinished(this.terminals, this.maxTerminals)) {
      throw new ResourceExhaustedError('terminals (all are still running)');
    }
    const id = `term-${++this._termSeq}`;
    const child = spawn('bash', [], { cwd, env, detached: true });
    const t = {
      id, child, buffer: '', exitCode: null,
      createdAt: new Date().toISOString(), createdAtMs: Date.now(), lastActivityMs: Date.now(),
    };
    const append = (d) => {
      t.buffer += d.toString('utf8');
      if (t.buffer.length > 512 * 1024) t.buffer = t.buffer.slice(t.buffer.length - 512 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('exit', (code) => { t.exitCode = code; t.finishedAt = Date.now(); });
    child.on('error', (e) => { t.exitCode = -1; append(`\n[terminal spawn error: ${e.message}]\n`); });
    this.terminals.set(id, t);
    return t;
  }

  getTerminal(id) { return this.terminals.get(id) || null; }

  listTerminals() {
    return [...this.terminals.values()].map((t) => ({
      id: t.id, pid: t.child.pid, running: t.exitCode === null,
      exit_code: t.exitCode, buffered_bytes: t.buffer.length,
    }));
  }

  sendTerminal(id, input) {
    const t = this.terminals.get(id);
    if (!t) return null;
    t.lastActivityMs = Date.now();
    t.child.stdin.write(input);
    return t;
  }

  killTerminal(id, signal = 'SIGTERM') {
    const t = this.terminals.get(id);
    if (!t) return false;
    killGroup(t.child, signal === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL');
    // Give SIGTERM a brief grace period, then SIGKILL the group.
    if (signal === 'SIGTERM' && t.exitCode === null) {
      setTimeout(() => { if (t.exitCode === null) killGroup(t.child, 'SIGKILL'); }, 2000).unref?.();
    }
    this.terminals.delete(id);
    return true;
  }

  // --- exec jobs ---
  startJob({ command, cwd, useShell, allowlist, timeoutMs }) {
    this.sweep();
    if (!this._evictFinished(this.jobs, this.maxJobs)) {
      throw new ResourceExhaustedError('jobs (all are still running)');
    }
    const id = `job-${++this._jobSeq}`;
    let child;
    if (useShell) {
      child = spawn('bash', ['-c', command], { cwd, detached: true });
    } else {
      const argv = command.split(/\s+/);
      child = spawn(argv[0], argv.slice(1), { cwd, detached: true });
    }
    const job = {
      id, child, command, output: '', exitCode: null, status: 'running',
      startedAt: new Date().toISOString(), startedAtMs: Date.now(),
      lastPolledAtMs: Date.now(), finishedAt: null, timer: null,
    };
    const append = (d) => {
      job.output += d.toString('utf8');
      if (job.output.length > 512 * 1024) job.output = job.output.slice(-512 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('exit', (code) => {
      if (job.status === 'running') { job.status = 'done'; job.exitCode = code; }
      job.finishedAt = Date.now();
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    });
    child.on('error', (e) => {
      job.status = 'done'; job.exitCode = -1; job.finishedAt = Date.now();
      job.output += `\n[spawn error: ${e.message}]\n`;
    });
    job.timer = setTimeout(() => {
      if (job.status === 'running') {
        job.status = 'timeout'; job.finishedAt = Date.now();
        killGroup(child, 'SIGKILL');
      }
    }, timeoutMs);
    if (job.timer.unref) job.timer.unref();
    this.jobs.set(id, job);
    return job;
  }

  getJob(id) {
    const job = this.jobs.get(id) || null;
    if (job) job.lastPolledAtMs = Date.now();
    return job;
  }

  killJob(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'running') {
      job.status = 'killed'; job.finishedAt = Date.now();
      killGroup(job.child, 'SIGKILL');
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    }
    return job;
  }

  counts() { return { terminals: this.terminals.size, jobs: this.jobs.size }; }
}

module.exports = { ProcessManager, killGroup, ResourceExhaustedError, DEFAULT_MAX_TERMINALS, DEFAULT_MAX_JOBS };
