'use strict';
/**
 * lib/audit.js — audit log v3 (P0).
 * - Rotasi: max 10 MB per file, keep 3 (audit.log, audit.log.1, .2).
 * - Fail-loud: gagal tulis -> console.error + degraded=true, jangan catch{} diam.
 * - Tanpa secret: pemanggil TIDAK BOLEH mengirim input terminal / isi file;
 *   hanya id + panjang. Fungsi ini tidak memfilter — kontraknya di pemanggil.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 3;

class AuditLog {
  constructor(dir) {
    this.dir = dir || path.join(os.homedir(), '.muse-ai-local-bridge');
    this.file = path.join(this.dir, 'audit.log');
    this.degraded = false;
  }

  log(tool, target, result) {
    const line = `${new Date().toISOString()}\t${tool}\t${String(target).replace(/[\r\n\t]/g, ' ')}\t${String(result).replace(/[\r\n\t]/g, ' ')}\n`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        const st = fs.statSync(this.file);
        if (st.size + Buffer.byteLength(line) > MAX_BYTES) this._rotate();
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      fs.appendFileSync(this.file, line);
    } catch (e) {
      this.degraded = true;
      console.error(`[audit] FAILED to write audit log (${this.file}): ${e.message} — audit is DEGRADED, tool result unaffected`);
    }
  }

  _rotate() {
    // audit.log.2 -> delete, .1 -> .2, audit.log -> .1
    try { fs.rmSync(path.join(this.dir, 'audit.log.2'), { force: true }); } catch {}
    for (let i = KEEP - 2; i >= 1; i--) {
      try { fs.renameSync(path.join(this.dir, `audit.log.${i}`), path.join(this.dir, `audit.log.${i + 1}`)); } catch {}
    }
    try { fs.renameSync(this.file, path.join(this.dir, 'audit.log.1')); } catch {}
  }

  isDegraded() { return this.degraded; }
}

module.exports = { AuditLog, MAX_BYTES, KEEP };
