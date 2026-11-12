'use strict';
/**
 * lib/fs-service.js — FSService v3 (P1).
 * - Walk cache per root+start dir (TTL 2 detik, invalidasi eksplisit
 *   setelah write tool berhasil). Cache menyimpan daftar mentah
 *   {rel, isDir}; filter (hidden/ignore/blocklist/depth) tetap di pemanggil
 *   supaya semantik list_files tidak berubah.
 * - Range read: baca file per chunk, hitung baris tanpa split seluruh file
 *   (read_file 931 KB: 5,5 ms -> ~1-2 ms). Mengembalikan total_lines juga.
 */
const fs = require('node:fs');
const path = require('node:path');

const WALK_TTL_MS = 2000;

class FSService {
  constructor({ isIgnored, isBlocked } = {}) {
    this.isIgnored = isIgnored || (() => false);
    this.isBlocked = isBlocked || (() => false);
    this._walkCache = new Map(); // key -> {at, entries}
    this._listCache = new Map(); // key -> {at, value} (filtered results, TTL 2s)
  }

  invalidate(rootPath) {
    for (const key of [...this._walkCache.keys()]) {
      if (key.startsWith(rootPath + '|')) this._walkCache.delete(key);
    }
    for (const key of [...this._listCache.keys()]) {
      if (key.startsWith(rootPath + '|')) this._listCache.delete(key);
    }
  }

  invalidateAll() { this._walkCache.clear(); this._listCache.clear(); }

  /** Cached filtered result (e.g. list_files output). TTL 2s, same as walk. */
  cachedList(key, buildFn) {
    const now = Date.now();
    const hit = this._listCache.get(key);
    if (hit && now - hit.at < WALK_TTL_MS) return hit.value;
    const value = buildFn();
    this._listCache.set(key, { at: now, value });
    return value;
  }

  /**
   * Full recursive walk (raw entries, no filtering except cap).
   * Cached per root+startAbs for WALK_TTL_MS. Each entry carries
   * relFromStart (path relative to startAbs) and depth (0 = direct
   * child of startAbs) so hot loops never call path.relative per entry.
   */
  walkRaw(root, startAbs, cap = 5000) {
    const key = `${root.path}|${startAbs}`;
    const now = Date.now();
    const hit = this._walkCache.get(key);
    if (hit && now - hit.at < WALK_TTL_MS) return hit.entries;
    const entries = [];
    const walk = (dir) => {
      if (entries.length >= cap) return;
      let dirEntries;
      try { dirEntries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      dirEntries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of dirEntries) {
        if (entries.length >= cap) return;
        const abs = path.join(dir, e.name);
        const rel = path.relative(root.path, abs);
        const relFromStart = path.relative(startAbs, abs);
        const isDir = e.isDirectory();
        entries.push({ abs, rel, relFromStart, depth: relFromStart.split(path.sep).length - 1, isDir, name: e.name });
        if (isDir) walk(abs);
      }
    };
    try {
      const st = fs.statSync(startAbs);
      if (st.isDirectory()) walk(startAbs);
      else entries.push({ abs: startAbs, rel: path.relative(root.path, startAbs), relFromStart: '', depth: -1, isDir: false, name: path.basename(startAbs) });
    } catch { /* missing path: empty list */ }
    this._walkCache.set(key, { at: now, entries });
    return entries;
  }
}

/**
 * Read only the requested line range [offset, offset+limit) plus the total
 * line count. The whole file is read (one syscall), but newlines are found
 * with native Buffer.indexOf and only wanted lines are decoded — no
 * split() of the whole file, no per-character JS loop.
 * Returns {lines, totalLines, content}. totalLines matches v2 semantics
 * (content.split('\n').length).
 */
function readLinesRange(absPath, offset = 0, limit = 200) {
  const buf = fs.readFileSync(absPath);
  if (buf.length === 0) return { lines: [], totalLines: 1, content: '' };
  const wanted = [];
  let totalLines = 0;
  let lineNo = 0;
  let start = 0;
  let idx;
  while ((idx = buf.indexOf(0x0a, start)) !== -1) {
    if (lineNo >= offset && lineNo < offset + limit) {
      wanted.push(buf.subarray(start, idx).toString('utf8'));
    }
    lineNo++;
    totalLines++;
    start = idx + 1;
  }
  // Trailing segment (last line without '\n', or the '' after a final '\n').
  if (start < buf.length) {
    if (lineNo >= offset && lineNo < offset + limit) {
      wanted.push(buf.subarray(start).toString('utf8'));
    }
    totalLines++;
  } else {
    // File ends with '\n': v2's split() counts one trailing empty line,
    // and slice().join('\n') keeps it — so include '' when it is in range.
    if (lineNo >= offset && lineNo < offset + limit) wanted.push('');
    totalLines++;
  }
  return { lines: wanted, totalLines, content: wanted.join('\n') };
}

module.exports = { FSService, readLinesRange, WALK_TTL_MS };
