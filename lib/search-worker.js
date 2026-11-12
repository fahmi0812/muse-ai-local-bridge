'use strict';
/**
 * lib/search-worker.js — worker thread untuk grep/search (RC5, P1).
 * Dijalankan via node:worker_threads oleh lib/search.js. Membaca file
 * dari daftar yang dikirim main thread, mencocokkan regex/literal per
 * baris, early-exit di cap. Tidak ada akses ke Gate/server — murni I/O.
 * Pesan masuk: {files:[{abs,rel}], pattern, isRegex, flags, contextLines, cap}
 * Pesan keluar: {matches:[{path,line,context}], truncated} atau {error}
 */
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');

function isBinary(buf) { return buf.includes(0); }

parentPort.on('message', (job) => {
  try {
    const { files, pattern, isRegex, flags, contextLines, cap } = job;
    const re = isRegex ? new RegExp(pattern, flags || '') : null;
    // Prefilter (bench fix, measured): Buffer.includes is native and skips
    // the toString()+split() decode for files that cannot match. It is
    // only sound when the match is a plain byte substring:
    //  - literal search: always (pattern is matched verbatim, metachars
    //    included — Buffer.includes is verbatim too);
    //  - regex: only when the pattern has no regex metacharacters AND
    //    no 'i' flag (case-insensitive matching is not byte-equal).
    // Anything else falls through to the per-line test below, unchanged.
    const plainLiteral = !isRegex || (!/[.*+?^${}()|[\]\\]/.test(pattern) && !(flags || '').includes('i'));
    const prefilter = plainLiteral ? Buffer.from(pattern, 'utf8') : null;
    const matches = [];
    for (const { abs, rel } of files) {
      if (matches.length >= cap) break;
      let buf;
      try {
        const st = fs.statSync(abs);
        if (st.size > 1024 * 1024) continue;
        buf = fs.readFileSync(abs);
      } catch { continue; }
      if (isBinary(buf.subarray(0, 8000))) continue;
      if (prefilter && !buf.includes(prefilter)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && matches.length < cap; i++) {
        const hit = isRegex ? re.test(lines[i]) : lines[i].includes(pattern);
        if (hit) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length, i + contextLines + 1);
          matches.push({ path: rel, line: i + 1, context: lines.slice(start, end).join('\n') });
        }
      }
    }
    parentPort.postMessage({ matches, truncated: matches.length >= cap });
  } catch (e) {
    parentPort.postMessage({ error: e.message });
  }
});
