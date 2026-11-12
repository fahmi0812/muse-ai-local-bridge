'use strict';
/**
 * lib/gate.js — Gate terpusat (v3, P0).
 *
 * Satu-satunya tempat yang memutuskan "boleh / tidak" untuk semua jalur
 * HTTP + MCP: git ref/argv, path + blocklist, regex, ukuran file.
 * Fail-closed: kalau Gate di-disable (enabled:false), SEMUA validator
 * melempar GATE_DISABLED — tidak ada jalur yang lolos diam-diam.
 * Deletion test: hapus/nonaktifkan Gate -> write/shell/git gagal (lihat
 * test/bridge-v3.test.js: gate unit + HTTP MUSE_BRIDGE_GATE_DISABLED=1).
 *
 * Zero-deps, Node stdlib saja. Tidak ada I/O di sini (pure) kecuali
 * validateSize yang menerima angka ukuran dari pemanggil.
 */
const path = require('node:path');

const MAX_REGEX_LEN = 200;
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

// Pola nested-quantifier sederhana yang rawan ReDoS. Ini deteksi
// heuristik (bukan parser regex lengkap): grup yang berisi quantifier
// (+ * {m,}) lalu langsung di-quantifier lagi, atau '.*'/' .+' di dalam
// grup yang diulang. Pola legal biasa (mis. 'TODO|hello', '\d+') lolos.
const NESTED_QUANTIFIER_RES = [
  /\([^()]*[+*][^()]*\)[+*]/,          // (a+)+  (a*)*  (x+)? dst.
  /\([^()]*\.\*[^()]*\)[+*]/,          // (.*)*  (.*)+
  /\([^()]*\.\+[^()]*\)[+*]/,          // (.+)+
  /\([^()]*\{[^}]*\}[^()]*\)[+*?]/,    // (a{2,})+
  /(\+\*|\*\+|\+\+|\*\*)/,             // quantifier ganda berurutan
];

const GIT_REF_RE = /^[A-Za-z0-9._\/-]+$/;

/** Extended secret blocklist (v3): v2 + secret modern.
 *  Works on a root-relative POSIX path (no path.relative needed). */
function isBlockedRel(relPosix) {
  const parts = relPosix.split('/');
  for (const part of parts) {
    if (part === '.ssh' || part === '.aws' || part === '.gnupg') return true;
    if (/^\.env(\..+)?$/.test(part) && part !== '.env.example' && part !== '.env.sample') return true;
    if (part.endsWith('.key') || part.endsWith('.pem')) return true;
    if (part === '.npmrc' || part === '.git-credentials' || part === '.netrc') return true;
    if (part === 'credentials.json') return true;
    if (part.endsWith('.token')) return true;
  }
  // .docker/config.json (exact file, anywhere under the root).
  if (relPosix === '.docker/config.json' || relPosix.endsWith('/.docker/config.json')) return true;
  return false;
}

function isBlockedPath(absPath, rootPath) {
  return isBlockedRel(path.relative(rootPath, absPath).split(path.sep).join('/'));
}

class GateDisabledError extends Error {
  constructor(what) {
    super(`GATE_DISABLED: Gate is disabled, refusing ${what}`);
    this.code = 'GATE_DISABLED';
  }
}
class GateRejectedError extends Error {
  constructor(message) {
    super(`BAD_ARGS: ${message}`);
    this.code = 'BAD_ARGS';
  }
}

class Gate {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled !== false;
  }

  _requireEnabled(what) {
    if (!this.enabled) throw new GateDisabledError(what);
  }

  /** Validate a git ref/remote/branch name. Rejects leading '-' (RC1). */
  validateRef(s) {
    this._requireEnabled('validateRef');
    if (typeof s !== 'string' || !s) throw new GateRejectedError('ref is required');
    if (s.startsWith('-')) throw new GateRejectedError(`invalid ref (must not start with '-'): ${s}`);
    if (s.includes('..')) throw new GateRejectedError(`invalid ref (must not contain '..'): ${s}`);
    if (!GIT_REF_RE.test(s)) throw new GateRejectedError(`invalid ref (letters, digits, . _ / - only): ${s}`);
    return s;
  }

  /**
   * Build a git argv: internal flags first, then '--', then positional args.
   * User-supplied args starting with '-' are rejected unless explicitly
   * allowlisted by the caller (internal flags only, e.g. '--cached').
   * Returns a NEW array; never mutates inputs.
   */
  validateArgv(baseArgs, positionalArgs = [], { allowFlags = [] } = {}) {
    this._requireEnabled('validateArgv');
    const out = [...baseArgs];
    for (const a of positionalArgs) {
      if (typeof a !== 'string') throw new GateRejectedError('argv args must be strings');
      if (a.startsWith('-') && !allowFlags.includes(a)) {
        throw new GateRejectedError(`argument must not start with '-': ${a}`);
      }
    }
    const flags = positionalArgs.filter((a) => a.startsWith('-'));
    const positionals = positionalArgs.filter((a) => !a.startsWith('-'));
    // Allowlisted flags go with the base args; positionals go after '--'.
    out.push(...flags);
    if (positionals.length) out.push('--', ...positionals);
    return out;
  }

  /**
   * Validate a list of {path} entries against root scope + blocklist.
   * Returns the resolved absolute paths. Throws GateRejectedError with
   * code FILE_BLOCKED / PATH_OUTSIDE_ROOT / PATH_NOT_FOUND.
   * `resolve` is injected (server.js resolveInRoot) to keep this module pure.
   */
  validatePaths(entries, { root, resolve } = {}) {
    this._requireEnabled('validatePaths');
    if (!root || typeof resolve !== 'function') throw new Error('validatePaths needs {root, resolve}');
    const out = [];
    for (const e of entries) {
      const f = typeof e === 'string' ? e : e.path;
      if (typeof f !== 'string') throw new GateRejectedError('files must be strings');
      const r = resolve(f, root);
      if (r.error) {
        const err = new Error(r.message || r.error);
        err.code = r.error;
        throw err;
      }
      if (isBlockedPath(r.path, root.path)) {
        const err = new Error('path is on the secret blocklist');
        err.code = 'FILE_BLOCKED';
        throw err;
      }
      out.push(r.path);
    }
    return out;
  }

  /** Regex gate (RC5): length cap + nested-quantifier rejection. */
  validateRegex(pattern) {
    this._requireEnabled('validateRegex');
    if (typeof pattern !== 'string' || !pattern) throw new GateRejectedError('pattern is required');
    if (pattern.length > MAX_REGEX_LEN) {
      throw new GateRejectedError(`pattern too long (max ${MAX_REGEX_LEN} chars)`);
    }
    for (const re of NESTED_QUANTIFIER_RES) {
      if (re.test(pattern)) {
        throw new GateRejectedError(`pattern looks like a nested-quantifier ReDoS risk: ${pattern.slice(0, 60)}`);
      }
    }
    let compiled;
    try { compiled = new RegExp(pattern); } catch (e) {
      throw new GateRejectedError(`invalid regex: ${e.message}`);
    }
    void compiled;
    return pattern;
  }

  /** Size gate (RC6): reject before any read. */
  validateSize(sizeBytes, maxBytes = MAX_FILE_BYTES) {
    this._requireEnabled('validateSize');
    if (typeof sizeBytes !== 'number' || Number.isNaN(sizeBytes)) {
      throw new GateRejectedError('size is required');
    }
    if (sizeBytes > maxBytes) {
      throw new GateRejectedError(`file too large (${sizeBytes} bytes, max ${maxBytes})`);
    }
    return true;
  }

  /** Blocklist check on a root-relative POSIX path (hot loops). */
  isBlockedRel(relPosix) {
    return isBlockedRel(relPosix);
  }

  /** Blocklist check shared by every path-taking tool.
   *  The blocklist is static data, not a Gate switch: it stays enforced
   *  even when the Gate is disabled (fail-closed for reads of secrets,
   *  while ordinary reads keep working — see the deletion test). */
  isBlocked(absPath, rootPath) {
    return isBlockedPath(absPath, rootPath);
  }
}

function createGate(opts) { return new Gate(opts); }

module.exports = { Gate, createGate, isBlockedPath, isBlockedRel, MAX_REGEX_LEN, MAX_FILE_BYTES, GateDisabledError, GateRejectedError };
