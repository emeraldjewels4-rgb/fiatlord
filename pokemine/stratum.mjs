// A stratum client, speaking to a real pool on the operator's behalf.
//
// The browser never sees the pool password and never opens a TCP socket: it asks
// this process for a job, hashes it, and hands a winning nonce back. That keeps
// one place that understands the protocol (this file) and one place that can
// reach the internet (also this file), and it means the pool credential never
// becomes a browser value.
//
// What a share is, and is not: a share is a header whose hash is under the
// pool's share target. The pool accepts it, counts it and credits the account.
// A share is not a block - the block target is ~8.8e18 times harder than the
// sim's D4 target, and no browser reaches it. Shares pay in proportion to work
// only after the pool's fee and only in whole satoshi payouts, so at 300 kH/s
// the honest expectation is nothing.

import net from 'node:net';
import { EventEmitter } from 'node:events';

// Difficulty 1, the unit every pool's difficulty is quoted in:
// 0x00000000ffff0000 followed by 48 zeroes, i.e. 0xffff * 2^208. Getting the
// shift wrong makes every share a false positive, so selftest pins this.
export const DIFF1_TARGET = 0x00000000ffff0000n << 192n;

/** Target for a (possibly fractional) share difficulty. */
export function targetForDifficulty(difficulty) {
  const diff = Number(difficulty);
  if (!Number.isFinite(diff) || diff <= 0) throw new Error('bad difficulty');
  // Scaled integer maths, so 0.001 does not get rounded to zero.
  return (DIFF1_TARGET * 1000000n) / BigInt(Math.round(diff * 1000000));
}

/**
 * Stratum sends the previous block hash as 32-bit words in reverse order with
 * each word's bytes left alone; a block header wants the whole thing byte
 * reversed. Doing both is the same as reversing the bytes inside each word and
 * leaving the words in place - which is what this does.
 *
 * Checked against a live job in selftest.mjs: the result equals the byte-reverse
 * of the tip hash mempool.space reports for the same height.
 */
export function headerPrevHash(prevhashHex) {
  const words = String(prevhashHex).match(/.{8}/g);
  if (!words || words.length !== 8) throw new Error('prevhash must be 32 bytes');
  return words.map((word) => word.match(/../g).reverse().join('')).join('');
}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]{2,252})$/i;
const REQUEST_TIMEOUT = 15000;
const RECONNECT_MIN = 2000;
const RECONNECT_MAX = 30000;

export class PoolBridge extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.config = null; // { host, port, user, pass, suggest } - never leaves this process
    this.state = 'idle';
    this.error = null;
    this.stopped = true;
    this.reconnectTimer = null;
    this.reconnectDelay = RECONNECT_MIN;
    this.subscription = null; // { extranonce1, extranonce2Size }
    this.difficulty = null;
    this.job = null;
    this.shares = { accepted: 0, rejected: 0 };
    this.lastShare = null;
    this.connectedAt = null;
  }

  start(config) {
    const host = String(config?.host || '').trim().toLowerCase();
    const port = Number(config?.port);
    const user = String(config?.user || '').trim();
    const pass = String(config?.pass ?? 'x');
    const suggest = Number(config?.suggest);

    if (!HOST_RE.test(host)) throw new Error('pool host looks wrong');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('pool port must be 1-65535');
    if (!user || user.length > 160 || /[\s"]/.test(user)) throw new Error('username (payout address) is required');
    if (!Number.isFinite(suggest) || suggest <= 0) throw new Error('suggested difficulty must be positive');

    this.stop({ quiet: true });
    this.config = { host, port, user, pass, suggest };
    this.stopped = false;
    this.reconnectDelay = RECONNECT_MIN;
    this.connect();
    return this.status();
  }

  stop({ quiet = false } = {}) {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('pool connection closed'));
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (!quiet) {
      this.state = 'idle';
      this.job = null;
      this.subscription = null;
      this.difficulty = null;
      this.connectedAt = null;
    }
    this.emit('state', this.state);
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      host: this.config?.host ?? null,
      port: this.config?.port ?? null,
      user: this.config?.user ?? null,
      connectedAt: this.connectedAt,
      difficulty: this.difficulty,
      shareTarget: this.difficulty ? `0x${targetForDifficulty(this.difficulty).toString(16)}` : null,
      extranonce1: this.subscription?.extranonce1 ?? null,
      extranonce2Size: this.subscription?.extranonce2Size ?? null,
      shares: { ...this.shares },
      lastShare: this.lastShare,
      job: this.job,
    };
  }

  /* ------------------------------------------------------------ connection */

  connect() {
    this.state = 'connecting';
    this.error = null;
    this.emit('state', this.state);

    const socket = net.createConnection({ host: this.config.host, port: this.config.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(60000, () => {
      // A silent pool is a dead pool; keepalive-only sockets idle out.
      socket.destroy(new Error('pool sent nothing for 60s'));
    });

    socket.on('connect', () => {
      this.connectedAt = Date.now();
      this.state = 'subscribing';
      this.emit('state', this.state);
      this.send('mining.subscribe', ['pokemine-console/2.0']).then(
        (result) => this.onSubscribed(result),
        (err) => this.fail(err.message),
      );
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err.message));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('pool connection closed'));
      }
      this.pending.clear();
      if (this.stopped) {
        this.state = 'idle';
        this.emit('state', this.state);
        return;
      }
      this.state = 'offline';
      this.emit('state', this.state);
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(RECONNECT_MAX, Math.round(this.reconnectDelay * 1.7));
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  fail(message) {
    this.error = message;
    this.emit('error-note', message);
    if (this.socket) this.socket.destroy();
  }

  async onSubscribed(result) {
    const [, extranonce1, extranonce2Size] = Array.isArray(result) ? result : [];
    if (typeof extranonce1 !== 'string' || !Number.isInteger(extranonce2Size)) {
      throw new Error('pool did not return an extranonce');
    }
    this.subscription = { extranonce1, extranonce2Size };
    this.state = 'authorizing';
    this.emit('state', this.state);

    const accepted = await this.send('mining.authorize', [this.config.user, this.config.pass]);
    if (accepted !== true) throw new Error('pool refused the username');
    // Ask for the lowest difficulty the pool will give a small miner. Pools
    // clamp this (public-pool answers 1), which is why shares stay rare.
    this.send('mining.suggest_difficulty', [this.config.suggest]).catch(() => {});
    this.state = 'ready';
    this.reconnectDelay = RECONNECT_MIN;
    this.emit('state', this.state);
  }

  /* ------------------------------------------------------------- protocol */

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // a pool that logs to the socket; not ours to parse
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) {
        const detail = Array.isArray(message.error) ? message.error.slice(1).filter(Boolean).join(' ') : String(message.error);
        reject(new Error(detail || 'pool error'));
      } else {
        resolve(message.result);
      }
      return;
    }

    if (message.method === 'mining.set_difficulty') {
      const difficulty = Number(message.params?.[0]);
      if (Number.isFinite(difficulty) && difficulty > 0) {
        this.difficulty = difficulty;
        this.emit('difficulty', difficulty);
      }
    } else if (message.method === 'mining.set_extranonce') {
      const [extranonce1, extranonce2Size] = message.params || [];
      if (typeof extranonce1 === 'string' && Number.isInteger(extranonce2Size)) {
        this.subscription = { extranonce1, extranonce2Size };
        this.emit('extranonce', this.subscription);
      }
    } else if (message.method === 'mining.notify') {
      const [id, prevhash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs] = message.params || [];
      try {
        this.job = {
          id,
          prevhashField: headerPrevHash(prevhash),
          coinb1,
          coinb2,
          merkleBranch: Array.isArray(merkleBranch) ? merkleBranch : [],
          version,
          nbits,
          ntime,
          cleanJobs: Boolean(cleanJobs),
          receivedAt: Date.now(),
        };
        this.emit('job', this.job);
      } catch (err) {
        this.emit('error-note', `unusable job: ${err.message}`);
      }
    } else if (message.method === 'client.reconnect') {
      this.fail('pool asked this client to reconnect');
    } else if (message.method === 'client.get_version') {
      this.send('mining.configure', []).catch(() => {});
    }
  }

  send(method, params) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Hand a winning nonce to the pool; resolves with the pool's verdict. */
  async submit({ jobId, extranonce2, ntime, nonce }) {
    if (this.state !== 'ready') throw new Error('pool is not ready');
    if (!/^[0-9a-f]{2,32}$/i.test(String(extranonce2))) throw new Error('bad extranonce2');
    if (!/^[0-9a-f]{8}$/i.test(String(ntime))) throw new Error('bad ntime');
    if (!/^[0-9a-f]{8}$/i.test(String(nonce))) throw new Error('bad nonce');
    const started = Date.now();
    try {
      const result = await this.send('mining.submit', [this.config.user, jobId, extranonce2, ntime, nonce]);
      const accepted = result === true;
      if (accepted) this.shares.accepted += 1;
      else this.shares.rejected += 1;
      this.lastShare = { accepted, at: Date.now(), ms: Date.now() - started, jobId, error: accepted ? null : 'pool rejected' };
      this.emit('share', this.lastShare);
      return this.lastShare;
    } catch (err) {
      this.shares.rejected += 1;
      this.lastShare = { accepted: false, at: Date.now(), ms: Date.now() - started, jobId, error: err.message };
      this.emit('share', this.lastShare);
      return this.lastShare;
    }
  }
}
