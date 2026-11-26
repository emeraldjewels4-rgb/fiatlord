// Static server for the console, plus the only place a chain is talked to.
//
// The browser asks this process for a chain head; this process asks the chain.
// That keeps upstream CORS, retries, caching and URL validation in one file,
// and it means a currency added from the UI needs no new browser code.

import { createServer } from 'node:http';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PoolBridge } from './stratum.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 8077;
const HOST = '127.0.0.1';
const UPSTREAM_TIMEOUT = 9000;
const CACHE_MS = 20000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const cache = new Map();

// One pool connection per console process. It holds the pool credential, so it
// lives here and is never handed to the browser.
const pool = new PoolBridge();
pool.on('error-note', (message) => console.error(`pool: ${message}`));

/** The pool endpoints are for this machine only: they spend the operator's hashrate. */
function isLoopback(req) {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Only public https hosts, or loopback http when the caller opted into a local node. */
function assertFetchable(raw, { allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('not a URL');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (loopback) {
    if (!allowLoopback) throw new Error('loopback is only allowed for a local node');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    return url;
  }
  if (url.protocol !== 'https:') throw new Error('upstream must be https');
  if (
    /^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('private host refused');
  }
  return url;
}

async function fetchJson(url, init = {}, timeout = UPSTREAM_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'pokemine-console/1.0', ...(init.headers || {}) },
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normaliseHead(raw, source) {
  return {
    height: toNumber(raw.height),
    hash: typeof raw.hash === 'string' ? raw.hash : null,
    difficulty: toNumber(raw.difficulty),
    timestamp: toNumber(raw.timestamp),
    source,
    fetchedAt: Date.now(),
  };
}

async function readMempool(base) {
  const url = assertFetchable(`${String(base).replace(/\/+$/, '')}/api/v1/blocks`);
  const blocks = await fetchJson(url);
  const head = Array.isArray(blocks) ? blocks[0] : null;
  if (!head) throw new Error('empty block list');
  return normaliseHead(
    { height: head.height, hash: head.id, difficulty: head.difficulty, timestamp: head.timestamp },
    url.origin,
  );
}

async function readBlockchair(base, chain) {
  if (!/^[a-z]{3,24}$/.test(String(chain || ''))) throw new Error('bad chain name');
  const root = `${String(base).replace(/\/+$/, '')}/${chain}`;
  try {
    const blocks = await fetchJson(assertFetchable(`${root}/blocks?limit=1`));
    const head = blocks?.data?.[0];
    if (head) {
      return normaliseHead(
        {
          height: head.height ?? head.id,
          hash: head.hash || head.block_hash,
          difficulty: head.difficulty,
          timestamp: head.time ? Date.parse(`${String(head.time).replace(' ', 'T')}Z`) / 1000 : null,
        },
        new URL(root).origin,
      );
    }
  } catch {
    // fall through to the cheaper stats endpoint
  }
  const stats = await fetchJson(assertFetchable(`${root}/stats`));
  const data = stats?.data || {};
  return normaliseHead(
    { height: data.blocks, hash: data.best_block_hash, difficulty: data.difficulty, timestamp: null },
    new URL(root).origin,
  );
}

async function readRpc(endpoint) {
  const url = assertFetchable(endpoint, { allowLoopback: true });
  const call = (method, params) =>
    fetchJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });

  try {
    const info = await call('getblockchaininfo', []);
    if (info?.result) {
      return normaliseHead(
        { height: info.result.blocks, hash: info.result.bestblockhash, difficulty: info.result.difficulty ?? null, timestamp: null },
        url.origin,
      );
    }
  } catch {
    // not a Bitcoin-family node; try EVM below
  }

  const block = await call('eth_getBlockByNumber', ['latest', false]);
  const result = block?.result;
  if (!result) throw new Error(block?.error?.message || 'node returned no block');

  let height = null;
  let difficulty = null;
  if (result.number) height = parseInt(result.number, 16);
  if (result.totalDifficulty) difficulty = parseInt(result.totalDifficulty, 16);
  else if (result.difficulty) difficulty = parseInt(result.difficulty, 16);
  let timestamp = null;
  if (result.timestamp) timestamp = parseInt(result.timestamp, 16);

  return normaliseHead({ height, hash: result.hash, difficulty, timestamp }, url.origin);
}

async function readChain(kind, params) {
  if (kind === 'mempool') return readMempool(params.url);
  if (kind === 'blockchair') return readBlockchair(params.url, params.chain);
  if (kind === 'rpc') return readRpc(params.url);
  throw new Error(`unknown adapter "${kind}"`);
}

async function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await producer();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === '/api/chain') {
      const kind = url.searchParams.get('kind') || 'mempool';
      const target = url.searchParams.get('url');
      if (!target) return jsonResponse(res, 400, { ok: false, error: 'url is required' });
      const params = { url: target, chain: url.searchParams.get('chain') || '' };
      const key = `chain:${kind}:${target}:${params.chain}`;
      const head = await cached(key, () => readChain(kind, params));
      return jsonResponse(res, 200, { ok: true, head });
    }

    if (url.pathname === '/api/price') {
      const ids = String(url.searchParams.get('ids') || '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^[a-z0-9-]{2,40}$/.test(id))
        .slice(0, 12);
      if (!ids.length) return jsonResponse(res, 400, { ok: false, error: 'ids is required' });
      const key = `price:${ids.join(',')}`;
      const prices = await cached(key, async () => {
        const api = assertFetchable(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
        );
        const data = await fetchJson(api);
        const out = {};
        for (const id of ids) if (data?.[id]?.usd) out[id] = data[id].usd;
        return out;
      });
      return jsonResponse(res, 200, { ok: true, prices });
    }

    if (url.pathname.startsWith('/api/pool')) {
      if (!isLoopback(req)) return jsonResponse(res, 403, { ok: false, error: 'pool control is loopback only' });

      if (url.pathname === '/api/pool/status') {
        return jsonResponse(res, 200, { ok: true, pool: pool.status() });
      }

      if (url.pathname === '/api/pool/start' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const status = pool.start({
            host: body.host,
            port: body.port,
            user: body.user,
            pass: body.pass,
            suggest: body.suggest ?? 0.001,
          });
          return jsonResponse(res, 200, { ok: true, pool: status });
        } catch (error) {
          return jsonResponse(res, 400, { ok: false, error: error.message });
        }
      }

      if (url.pathname === '/api/pool/stop' && req.method === 'POST') {
        pool.stop();
        return jsonResponse(res, 200, { ok: true, pool: pool.status() });
      }

      if (url.pathname === '/api/pool/submit' && req.method === 'POST') {
        const body = await readBody(req);
        const verdict = await pool.submit({
          jobId: String(body.jobId || ''),
          extranonce2: String(body.extranonce2 || ''),
          ntime: String(body.ntime || ''),
          nonce: String(body.nonce || ''),
        });
        return jsonResponse(res, 200, { ok: true, share: verdict });
      }

      return jsonResponse(res, 404, { ok: false, error: 'no such pool endpoint' });
    }

    return jsonResponse(res, 404, { ok: false, error: 'no such endpoint' });
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'upstream timed out' : String(error?.message || error);
    return jsonResponse(res, 502, { ok: false, error: message });
  }
}

async function serveStatic(res, pathname) {
  const relative = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(
    /^([/\\])+/,
    '',
  );
  const file = join(ROOT, relative);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, async () => {
  await writeFile(join(ROOT, '.server.pid'), String(process.pid)).catch(() => {});
  console.log(`pokemine console: http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await unlink(join(ROOT, '.server.pid')).catch(() => {});
    process.exit(0);
  });
}
