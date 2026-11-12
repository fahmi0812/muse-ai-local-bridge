'use strict';
/**
 * lib/git-service.js — GitService v3 (P1).
 * 1 spawn per call. git_status: 'status --porcelain=v1 -b' (branch +
 * status sekaligus). git_branch: 1 spawn + current branch dari .git/HEAD
 * (tanpa spawn), cache 1 detik diinvalidasi mtime .git/HEAD + .git/index.
 * Repo check tanpa spawn: .git ada (dir/file, worktree).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function gitRun(gitArgs, root, timeoutMs = 15000) {
  return spawnSync('git', gitArgs, { cwd: root.path, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
}

function isRepo(root) {
  try {
    const g = path.join(root.path, '.git');
    const st = fs.statSync(g);
    return st.isDirectory() || st.isFile();
  } catch { return false; }
}

// Current branch from .git/HEAD (0 spawns). Detached HEAD -> hash short.
function readCurrentBranch(root) {
  try {
    const head = fs.readFileSync(path.join(root.path, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) return m[1];
    return head.slice(0, 7) || null; // detached: short hash
  } catch { return null; }
}

class GitService {
  constructor() {
    this._branchCache = new Map(); // root.path -> {mtimeHead, mtimeIndex, at, current, branches}
  }

  isRepo(root) { return isRepo(root); }
  run(args, root, timeoutMs) { return gitRun(args, root, timeoutMs); }

  /** 1 spawn: branch + status. */
  status(root) {
    const r = gitRun(['status', '--porcelain=v1', '-b', '--untracked-files=normal'], root);
    if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git status failed').trim() };
    let branch = null;
    const files = [];
    for (const line of r.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('## ')) {
        const head = line.slice(3);
        // "main", "main...origin/main", "No commits yet on main", "HEAD (no branch)"
        const m = head.match(/^(?:No commits yet on )?([^\s.]+)/);
        branch = m ? m[1] : null;
        if (head.startsWith('HEAD')) branch = 'HEAD';
        continue;
      }
      files.push({ status: line.slice(0, 2).trim() || '?', path: line.slice(3).trim() });
    }
    return { branch, files };
  }

  /** 1 spawn for the list; current branch from .git/HEAD (cached 1s). */
  branch(root) {
    const now = Date.now();
    let mtimeHead = 0, mtimeIndex = 0;
    try { mtimeHead = fs.statSync(path.join(root.path, '.git', 'HEAD')).mtimeMs; } catch {}
    try { mtimeIndex = fs.statSync(path.join(root.path, '.git', 'index')).mtimeMs; } catch {}
    const cached = this._branchCache.get(root.path);
    if (cached && now - cached.at < 1000 && cached.mtimeHead === mtimeHead && cached.mtimeIndex === mtimeIndex) {
      return { current: cached.current, branches: cached.branches };
    }
    const r = gitRun(['branch', '--format=%(refname:short)'], root);
    if (r.status !== 0) return { error: 'INTERNAL_ERROR', message: (r.stderr || 'git branch failed').trim() };
    const out = { current: readCurrentBranch(root), branches: r.stdout.split('\n').filter(Boolean) };
    this._branchCache.set(root.path, { ...out, mtimeHead, mtimeIndex, at: now });
    return out;
  }

  /** Enumerate stageable files (tracked + untracked respecting .gitignore). */
  listStageable(root) {
    const tracked = gitRun(['ls-files', '-z'], root);
    const others = gitRun(['ls-files', '--others', '--exclude-standard', '-z'], root);
    if (tracked.status !== 0 || others.status !== 0) {
      return { error: 'INTERNAL_ERROR', message: 'git ls-files failed' };
    }
    const trackedList = tracked.stdout.split('\0').filter(Boolean);
    const othersList = others.stdout.split('\0').filter(Boolean);
    return { files: [...trackedList, ...othersList], tracked: trackedList, others: othersList };
  }
}

module.exports = { GitService, gitRun, isRepo, readCurrentBranch };
