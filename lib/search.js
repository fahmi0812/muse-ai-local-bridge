'use strict';
/**
 * lib/search.js — jalankan pencarian isi file di worker thread (RC5).
 * Timeout 2 detik: worker di-terminate, pemanggil mendapat TIMEOUT.
 * Worker gagal dibuat / crash -> tolak (error), bukan hang.
 *
 * Pool hangat: satu worker yang sama dipakai ulang antar panggilan
 * (spawn + JIT worker baru costs ~100 ms di VM ini; reuse -> ~20 ms).
 * Worker yang timeout/crash di-terminate dan TIDAK dikembalikan ke pool.
 * Bila semua worker sibuk, dibuat worker baru (maks 4); sisanya antre
 * di pool idle saat selesai.
 */
const { Worker } = require('node:worker_threads');
const path = require('node:path');

const WORKER_TIMEOUT_MS = 2000;
const MAX_WORKERS = 4;

const idleWorkers = [];

function createWorker() {
  const worker = new Worker(path.join(__dirname, 'search-worker.js'));
  worker.__searchDead = false;
  worker.once('exit', () => {
    worker.__searchDead = true;
    const i = idleWorkers.indexOf(worker);
    if (i !== -1) idleWorkers.splice(i, 1);
  });
  return worker;
}

function takeWorker() {
  while (idleWorkers.length) {
    const w = idleWorkers.pop();
    if (!w.__searchDead) return w;
  }
  return createWorker();
}

function runSearchInWorker(job, timeoutMs = WORKER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = takeWorker();
    } catch (e) {
      return resolve({ error: `worker failed to start: ${e.message}` });
    }
    let done = false;
    const finish = (result, keepWorker) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (keepWorker && idleWorkers.length < MAX_WORKERS) idleWorkers.push(worker);
      else { try { worker.terminate(); } catch {} }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: 'TIMEOUT', timeout: true }, false), timeoutMs);
    if (timer.unref) timer.unref();
    const onMessage = (msg) => {
      if (msg.error) finish({ error: msg.error }, false);
      else finish({ matches: msg.matches, truncated: msg.truncated }, true);
    };
    const onError = (e) => finish({ error: `worker error: ${e.message}` }, false);
    const onExit = (code) => {
      if (!done && code !== 0) finish({ error: `worker exited with code ${code}` }, false);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    try {
      worker.postMessage(job);
    } catch (e) {
      finish({ error: `worker postMessage failed: ${e.message}` }, false);
    }
  });
}

module.exports = { runSearchInWorker, WORKER_TIMEOUT_MS };
