import {
  COINS,
  GEN3_CHARSET,
  decodeGen3,
  encodeGen3,
  formatUnits,
  shortNumber,
  subsidyFor,
} from './coins.js';
import { Miner } from './miner.js';
import { PoolWorker } from './poolworker.js';
import { deriveKeypair, generateSeed } from './keypair.js';
import { sha256d, toHex } from './sha256.js';

const $ = (id) => document.getElementById(id);
const LS = {
  wallet: 'pokemine.wallet.v1',
  custom: 'pokemine.custom.v1',
  address: 'pokemine.address.v1',
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled: the session still works */
  }
}

const state = {
  coins: [...COINS],
  heads: {},
  prices: {},
  wallet: load(LS.wallet, {}),
  addresses: load(LS.address, {}),
  difficulty: COINS[0].difficulty,
  boost: 1,
  mining: false,
  activeId: COINS[0].id,
  groups: [],
  best: null,
  custom: load(LS.custom, []),
  // A demo key for this tab only: derived on load, never saved, never used as a
  // payout address. See keypair.js and the vault banner.
  keypair: null,
  revealKey: false,
};

state.coins.push(...state.custom);
const miner = new Miner({ onTick: updateHud, onSample: onSample, onBlock: onBlock });

const activeCoin = () => state.coins.find((coin) => coin.id === state.activeId) || state.coins[0];

function walletFor(id) {
  if (!state.wallet[id]) state.wallet[id] = { blocks: 0, earned: '0', mined: [] };
  return state.wallet[id];
}

function saveWallet() {
  save(LS.wallet, state.wallet);
}

function makeAddress(coin) {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${coin.addressPrefix || 'pm'}${hex.slice(0, 34)}`;
}

function addressFor(coin) {
  if (!state.addresses[coin.id]) {
    state.addresses[coin.id] = makeAddress(coin);
    save(LS.address, state.addresses);
  }
  return state.addresses[coin.id];
}

const shortHash = (hash) => (hash ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : '—');

/* ------------------------------------------------------------------ terminal */

function log(kind, text) {
  const body = $('terminal');
  const line = document.createElement('div');
  line.className = `term-line ${kind}`;
  const stamp = document.createElement('span');
  stamp.className = 't';
  stamp.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.append(stamp, document.createTextNode(text));
  body.append(line);
  while (body.children.length > 140) body.firstChild.remove();
  body.scrollTop = body.scrollHeight;
  $('terminal-count').textContent = `${body.children.length} lines`;
}

/* --------------------------------------------------------------------- state */

function setConn(kind, text) {
  $('conn-dot').className = `led ${kind}`;
  $('conn-text').textContent = text;
}

async function connect(coin, { silent = false } = {}) {
  if (coin.adapter?.kind === 'local') {
    const wallet = walletFor(coin.id);
    state.heads[coin.id] = {
      height: wallet.blocks || 0,
      hash: wallet.tip || null,
      difficulty: null,
      source: coin.source || 'local collectible',
      fetchedAt: Date.now(),
    };
    setConn('local', coin.collectible ? 'COLLECTIBLE' : 'LOCAL');
    renderChain();
    return;
  }
  const query = new URLSearchParams({ kind: coin.adapter.kind, url: coin.adapter.url });
  if (coin.adapter.chain) query.set('chain', coin.adapter.chain);
  if (!silent) setConn('busy', 'reading chain…');
  try {
    const response = await fetch(`/api/chain?${query}`);
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || 'chain read failed');
    state.heads[coin.id] = body.head;
    setConn('live', 'LIVE');
    if (coin.id === state.activeId) renderChain();
    renderRail();
    renderChain();
    if (!state.mining) configureFor(coin);
    if (!silent) {
      log('system', `[CHAIN] ${coin.ticker} head ${Number(body.head.height).toLocaleString('en-US')} via ${coin.adapter.kind}`);
    }
    return body.head;
  } catch (error) {
    setConn('offline', 'OFFLINE');
    if (!silent) log('err', `[CHAIN] ${coin.ticker}: ${error.message}`);
    return null;
  }
}

async function prefetchHeads() {
  await Promise.all(
    state.coins.map(async (coin) => {
      if (state.heads[coin.id]) return;
      const query = new URLSearchParams({ kind: coin.adapter.kind, url: coin.adapter.url });
      if (coin.adapter.chain) query.set('chain', coin.adapter.chain);
      try {
        const response = await fetch(`/api/chain?${query}`);
        const body = await response.json();
        if (body.ok) state.heads[coin.id] = body.head;
      } catch {
        /* one unreachable currency must not empty the rail */
      }
    }),
  );
  renderRail();
}

function configureFor(coin) {
  const head = state.heads[coin.id];
  const wallet = walletFor(coin.id);
  const height = (head?.height || 0) + wallet.blocks + 1;
  const genesis = toHex(sha256d(new TextEncoder().encode(`pokemine:${coin.id}`)));
  miner.configure({
    prevHashHex: wallet.tip || head?.hash || genesis,
    coinbase: `${coin.ticker}:${addressFor(coin)}:${height}`,
    difficulty: state.difficulty,
  });
  updateMemory();
}

async function updatePrice() {
  const ids = [...new Set(state.coins.map((coin) => coin.priceId).filter(Boolean))];
  if (!ids.length) return;
  try {
    const response = await fetch(`/api/price?ids=${ids.join(',')}`);
    const body = await response.json();
    if (!body.ok) return;
    state.prices = body.prices;
    renderPrice();
    renderWallet();
  } catch {
    /* prices are decoration; the rig keeps working without them */
  }
}

function priceOf(coin) {
  return (coin.priceId && state.prices[coin.priceId]) || 0;
}

/* ------------------------------------------------------------------ rendering */

function renderRail() {
  const rail = $('coin-rail');
  rail.textContent = '';
  for (const coin of state.coins) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `coin-chip${coin.id === state.activeId ? ' is-active' : ''}`;
    button.dataset.kind = coin.collectible ? 'collectible' : 'chain';
    button.setAttribute('aria-pressed', String(coin.id === state.activeId));

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = coin.color || '#8996a9';

    const label = document.createElement('span');
    label.textContent = coin.ticker;

    const height = document.createElement('span');
    height.className = 'chip-height';
    if (coin.collectible) {
      const finds = walletFor(coin.id).blocks;
      height.textContent = finds ? `${finds} found` : 'rune';
    } else {
      const head = state.heads[coin.id];
      height.textContent = head?.height ? `#${Number(head.height).toLocaleString('en-US')}` : '—';
    }

    button.append(swatch, label, height);
    if (coin.collectible) {
      const kind = document.createElement('span');
      kind.className = 'chip-kind';
      kind.textContent = 'RUNE';
      button.append(kind);
    }
    button.addEventListener('click', () => {
      if (coin.id !== state.activeId) selectCoin(coin.id);
    });
    rail.append(button);
  }
}

function renderChain() {
  const coin = activeCoin();
  const head = state.heads[coin.id];
  const collectible = Boolean(coin.collectible);
  $('chain-head-title').textContent = collectible ? 'RUNE SOURCE' : 'CHAIN CONNECTION';
  $('chain-label-height').textContent = collectible ? 'FINDS' : 'HEIGHT';
  $('chain-label-subsidy').textContent = collectible ? 'FIND REWARD' : 'BLOCK SUBSIDY';
  $('chain-label-diff').textContent = collectible ? 'NETWORK' : 'NETWORK DIFFICULTY';
  $('chain-label-hash').textContent = collectible ? 'LAST FIND' : 'HEAD BLOCK';
  $('chain-label-time').textContent = collectible ? 'UPDATED' : 'READ AT';
  $('chain-label-source').textContent = collectible ? 'SOURCE' : 'UPSTREAM';
  $('chain-hint').textContent = collectible
    ? (coin.description || 'Virtual collectible mined locally in this app. No on-chain broadcast or deployment.')
    : 'Live head read by the local proxy in server.mjs. Blocks you find extend this tip locally.';

  $('chain-adapter').textContent = collectible ? (coin.kindLabel || 'collectible') : coin.adapter.kind;
  const height = head?.height ?? (collectible ? walletFor(coin.id).blocks : null);
  $('chain-height').textContent = height != null ? Number(height).toLocaleString('en-US') : '—';
  $('chain-subsidy').textContent = `${formatUnits(subsidyFor(coin, height || 0), coin.decimals)} ${coin.ticker}`;
  $('chain-diff').textContent = collectible ? 'Local (virtual)' : (head?.difficulty ? shortNumber(head.difficulty) : '—');
  $('chain-hash').textContent = head?.hash || (collectible ? 'no finds yet' : '—');
  $('chain-time').textContent = head?.fetchedAt ? new Date(head.fetchedAt).toLocaleTimeString('en-GB') : '—';
  $('chain-source').textContent = head?.source || coin.source || coin.adapter.url || '—';
}

function renderPrice() {
  const coin = activeCoin();
  const price = priceOf(coin);
  if (coin.collectible && !price) {
    $('price-label').textContent = `${coin.ticker} RUNE`;
    $('price-value').textContent = 'COLLECTIBLE';
    return;
  }
  $('price-label').textContent = `${coin.ticker} / USD`;
  $('price-value').textContent = price ? `$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : '$—';
}

function setMetric(id, value, unit) {
  const el = $(id);
  el.textContent = value;
  if (unit) {
    const small = document.createElement('small');
    small.textContent = ` ${unit}`;
    el.append(small);
  }
}

function updateHud(stats = {}) {
  const coin = activeCoin();
  const wallet = walletFor(coin.id);
  const hashrate = stats.hashrate || 0;
  const [value, unit] = hashrate >= 1e6 ? [(hashrate / 1e6).toFixed(2), 'MH/s'] : hashrate >= 1e3 ? [(hashrate / 1e3).toFixed(2), 'kH/s'] : [hashrate.toFixed(0), 'H/s'];
  setMetric('hashrate', value, unit);
  setMetric('blocks-count', wallet.blocks);
  setMetric('earned', formatUnits(wallet.earned, coin.decimals), coin.ticker);
  const temp = 45 + state.boost * 5 + (state.mining ? 10 : 0) + Math.round(Math.random() * 2);
  setMetric('temp', `${temp}°C`);

  const progress = state.mining ? Math.max(0, Math.min(0.999, stats.progress || 0)) : 0;
  $('progress-bar').style.width = `${(progress * 100).toFixed(1)}%`;
  $('progress-label').textContent = `${(progress * 100).toFixed(1)}%`;
  $('scan-rate').textContent = state.mining ? `${value} ${unit} · ${shortNumber(stats.hashes || 0)} hashes` : 'waiting for the rig';
}

function renderWallet() {
  const list = $('wallet-list');
  list.textContent = '';
  let totalUsd = 0;

  for (const coin of state.coins) {
    const wallet = walletFor(coin.id);
    const balance = formatUnits(wallet.earned, coin.decimals);
    const usd = (Number(wallet.earned) / 10 ** coin.decimals) * priceOf(coin);
    totalUsd += usd;

    const row = document.createElement('div');
    row.className = `wallet-row${coin.id === state.activeId ? ' is-active' : ''}`;

    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = coin.ticker;

    const bal = document.createElement('span');
    bal.className = 'bal';
    bal.textContent = balance;
    const unit = document.createElement('small');
    unit.textContent = ` ${coin.ticker}`;
    bal.append(unit);

    const usdEl = document.createElement('span');
    usdEl.className = 'tick';
    usdEl.textContent = usd ? `$${usd.toFixed(2)}` : '—';

    const meta = document.createElement('span');
    meta.className = 'meta';
    const last = wallet.mined?.[0];
    if (last) {
      const countLabel = coin.collectible
        ? `${wallet.blocks} find${wallet.blocks === 1 ? '' : 's'}`
        : `${wallet.blocks} block${wallet.blocks === 1 ? '' : 's'}`;
      const lastLabel = coin.collectible ? 'last rune' : 'last';
      meta.textContent = `${countLabel} · ${lastLabel} ${shortHash(last.hash)}${last.verified ? ' ✓ verified' : ''}`;
    } else {
      meta.textContent = coin.collectible ? 'no runes collected yet' : 'no blocks yet';
    }

    row.append(tick, bal, usdEl, meta);
    list.append(row);
  }

  $('wallet-total').textContent = `$${totalUsd.toFixed(2)}`;
}

function renderAddress() {
  $('address-input').value = addressFor(activeCoin());
}

/* ------------------------------------------------------------------- keypair */

const MASK = '•••• •••• •••• ••••';
const inGroups = (hex) => hex.replace(/(.{8})/g, '$1 ').trim();

function newKeypair({ quiet = false } = {}) {
  try {
    state.keypair = deriveKeypair(generateSeed());
  } catch (error) {
    log('err', `[KEYS] could not derive a keypair: ${error.message}`);
    return;
  }
  state.revealKey = false;
  renderKeypair();
  if (!quiet) log('system', `[KEYS] new demo keypair derived · ${state.keypair.address}`);
}

function renderKeypair() {
  const pair = state.keypair;
  if (!pair) return;
  $('keypair-address').textContent = pair.address;
  $('keypair-pub').textContent = pair.publicKey;
  $('keypair-wif').textContent = state.revealKey ? pair.wif : MASK;
  $('keypair-seed').textContent = state.revealKey ? inGroups(pair.seed) : MASK;
  $('keypair-reveal').textContent = state.revealKey ? 'HIDE KEY' : 'REVEAL KEY';
}

/* ------------------------------------------------------------------- scanner */

function onSample({ hex }) {
  state.best = state.best ? (hex < state.best ? hex : state.best) : hex;
  const groups = hex.slice(0, 64).match(/.{4}/g) || [];
  for (const group of groups) state.groups.push({ group, zero: group === '0000' });
  if (state.groups.length > 32) state.groups.splice(0, state.groups.length - 32);
  renderScanner();
  updateMemory();
}

function renderScanner() {
  const grid = $('scanner-grid');
  grid.textContent = '';
  const cells = state.groups.length ? state.groups : Array.from({ length: 32 }, () => ({ group: '----', zero: false }));
  const fragment = document.createDocumentFragment();
  for (const cell of cells) {
    const span = document.createElement('span');
    span.className = `scan-cell${cell.zero ? ' zero' : ''}`;
    span.textContent = cell.group;
    fragment.append(span);
  }
  grid.append(fragment);

  $('scan-count').textContent = `${shortNumber(miner.hashes)} hashes`;
  if (state.best) {
    const zeros = (state.best.match(/^0*/) || [''])[0].length;
    $('scan-best').textContent = `best: ${zeros} leading zero${zeros === 1 ? '' : 's'} · ${shortHash(state.best)}`;
  }
}

function updateMemory() {
  const grid = $('mem-grid');
  grid.textContent = '';
  const header = miner.header;
  const fragment = document.createDocumentFragment();
  for (let i = 4; i < 36; i++) {
    const span = document.createElement('span');
    const byte = header[i] || 0;
    span.className = `mem-cell${byte === 0 ? ' zero' : ''}`;
    span.textContent = byte.toString(16).padStart(2, '0').toUpperCase();
    fragment.append(span);
  }
  grid.append(fragment);
  $('mem-nonce').textContent = `nonce ${miner.dv.getUint32(76, true)}`;
  $('mem-merkle').textContent = `merkle ${toHex(miner.merkle).slice(0, 16)}…`;
}

/* -------------------------------------------------------------------- mining */

function startMining() {
  const coin = activeCoin();
  state.mining = true;
  configureFor(coin);
  miner.setBoost(state.boost);
  miner.start();
  $('mine-btn').textContent = 'STOP MINING';
  $('mine-btn').classList.add('stop');
  $('rig-status').textContent = 'MINING';
  $('rig-status').classList.add('on');
  const mode = coin.collectible ? 'collecting' : 'mining';
  log('ok', `[RIG] ${mode} ${coin.ticker} at D${state.difficulty} · header ${shortHash(miner.headerHex())}`);
}

function stopMining() {
  state.mining = false;
  miner.stop();
  $('mine-btn').textContent = 'START MINING';
  $('mine-btn').classList.remove('stop');
  $('rig-status').textContent = 'IDLE';
  $('rig-status').classList.remove('on');
  updateHud();
}

function onBlock(block) {
  const coin = activeCoin();
  const wallet = walletFor(coin.id);
  const height = (state.heads[coin.id]?.height || 0) + wallet.blocks + 1;
  const reward = subsidyFor(coin, height);

  wallet.blocks += 1;
  wallet.earned = (BigInt(wallet.earned || '0') + BigInt(reward)).toString();
  wallet.tip = block.hash;
  wallet.mined = [
    { hash: block.hash, height, reward: String(reward), verified: block.verified, at: Date.now() },
    ...(wallet.mined || []),
  ].slice(0, 6);
  saveWallet();
  if (coin.adapter?.kind === 'local') {
    state.heads[coin.id] = { ...(state.heads[coin.id] || {}), height: wallet.blocks, hash: block.hash, fetchedAt: Date.now() };
  }
  renderWallet();
  renderRail();
  renderChain();
  updateHud({ hashrate: 0, progress: 1, hashes: miner.hashes });

  const findLabel = coin.collectible ? 'RUNE' : 'BLOCK';
  const verb = coin.collectible ? 'collected' : 'found';
  log('warn', `[${findLabel}] ${coin.ticker} #${height} ${verb} · nonce ${block.nonce} · D${block.difficulty}`);
  log('ok', `[${findLabel}] ${block.hash}`);
  log(
    block.verified ? 'hex' : 'err',
    block.verified
      ? '[VERIFY] header re-hash reproduces the block hash'
      : '[VERIFY] FAILED — hash does not reproduce',
  );
  log('system', `[AWARD] +${formatUnits(reward, coin.decimals)} ${coin.ticker} (virtual${coin.collectible ? ' collectible' : ''})`);
  const hexMsg = coin.collectible
    ? `COLLECTED ${formatUnits(reward, coin.decimals)} ${coin.ticker}`
    : `MINED ${formatUnits(reward, coin.decimals)} ${coin.ticker}`;
  log('hex', `HEX: ${encodeGen3(hexMsg)}`);

  if (state.mining) {
    setTimeout(() => {
      if (!state.mining) return;
      configureFor(activeCoin());
      miner.start();
    }, 800);
  }
}

/* ---------------------------------------------------------------------- hex */

let hexMode = 'encode';

function buildHexTable() {
  const table = $('hex-table');
  table.textContent = '';
  const entries = [...GEN3_CHARSET].sort((a, b) => a[0] - b[0]);
  for (const [code, character] of entries) {
    const cell = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = character === ' ' ? '␠' : character;
    const hex = document.createElement('b');
    hex.textContent = code.toString(16).toUpperCase().padStart(2, '0');
    cell.append(label, hex);
    table.append(cell);
  }
}

function renderHex() {
  const input = $('hex-input').value;
  const output = $('hex-output');
  const table = $('hex-table');
  const inputWrap = $('hex-input-wrap');
  const outputWrap = output.parentElement;

  inputWrap.hidden = hexMode === 'table';
  outputWrap.hidden = hexMode === 'table';
  table.hidden = hexMode !== 'table';

  if (hexMode === 'encode') {
    $('hex-input-label').textContent = 'TEXT INPUT';
    output.textContent = encodeGen3(input);
  } else if (hexMode === 'decode') {
    $('hex-input-label').textContent = 'HEX INPUT';
    const { text, bad } = decodeGen3(input);
    output.textContent = bad ? `${text}  (unreadable token: ${bad})` : text;
  }
}

/* ---------------------------------------------------------------------- pool */

// A real stratum connection lives in the server process; this side only mines the
// job it is given and hands back a winning nonce.
const pool = { worker: null, poller: null, jobId: null, difficulty: null, running: false };

function poolWorker() {
  if (!pool.worker) {
    pool.worker = new PoolWorker({
      onSubmit: submitShare,
      onTick: ({ hashrate, best }) => {
        $('pool-rate').textContent = hashrate >= 1e6 ? `${(hashrate / 1e6).toFixed(2)} MH/s` : hashrate >= 1e3 ? `${(hashrate / 1e3).toFixed(2)} kH/s` : `${hashrate.toFixed(0)} H/s`;
        $('pool-best').textContent = best > 0 ? `diff ${best.toFixed(6)}` : '—';
      },
    });
  }
  return pool.worker;
}

async function submitShare({ jobId, extranonce2, ntime, nonce, hash }) {
  log('warn', `[POOL] share candidate nonce ${nonce} · ${hash.slice(0, 16)}…`);
  try {
    const response = await fetch('/api/pool/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, extranonce2, ntime, nonce }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error);
    if (data.share?.accepted) log('ok', '[POOL] share ACCEPTED by the pool');
    else log('err', `[POOL] share rejected: ${data.share?.error || 'no reason given'}`);
  } catch (error) {
    log('err', `[POOL] submit failed: ${error.message}`);
  }
}

function applyPoolStatus(status) {
  const state = status?.state || 'idle';
  $('pool-state').textContent = state;
  $('pool-state').className = `pill${state === 'ready' ? ' live' : ''}`;
  $('pool-shares').textContent = `${status?.shares?.accepted ?? 0} accepted · ${status?.shares?.rejected ?? 0} rejected`;
  $('pool-diff').textContent = status?.difficulty != null ? String(status.difficulty) : '—';
  $('pool-job').textContent = status?.job ? `#${status.job.id} · nbits ${status.job.nbits} · ${status.job.merkleBranch.length} branches` : '—';
  $('pool-last').textContent = status?.lastShare
    ? `${status.lastShare.accepted ? 'accepted' : 'rejected'} ${new Date(status.lastShare.at).toLocaleTimeString('en-GB')}${status.lastShare.error ? ` · ${status.lastShare.error}` : ''}`
    : '—';

  const ready = state === 'ready' && status.job && status.extranonce1;
  if (!ready) {
    if (pool.worker) pool.worker.stop();
    return;
  }

  const worker = poolWorker();
  const changed = status.job.id !== pool.jobId || status.difficulty !== pool.difficulty;
  if (changed) {
    worker.setJob({
      job: status.job,
      extranonce1: status.extranonce1,
      extranonce2Size: status.extranonce2Size,
      difficulty: status.difficulty,
    });
    pool.jobId = status.job.id;
    pool.difficulty = status.difficulty;
    log('system', `[POOL] job #${status.job.id} · share difficulty ${status.difficulty ?? '?'}`);
  }
  worker.start();
}

async function pollPool() {
  try {
    const response = await fetch('/api/pool/status');
    const data = await response.json();
    if (data.ok) applyPoolStatus(data.pool);
  } catch {
    /* the server is restarting; the next poll will say so */
  }
}

function startPoolPolling() {
  if (pool.poller) return;
  pool.poller = setInterval(pollPool, 1500);
}

/* -------------------------------------------------------------------- select */

async function selectCoin(id, { silent = false } = {}) {
  const coin = state.coins.find((entry) => entry.id === id);
  if (!coin) return;
  const wasMining = state.mining;
  if (wasMining) stopMining();

  state.activeId = id;
  state.difficulty = Math.max(1, Math.min(6, coin.difficulty || 4));
  miner.hashes = 0;
  state.groups = [];
  state.best = null;

  $('difficulty-range').value = String(state.difficulty);
  $('difficulty-label').textContent = `D${state.difficulty}`;
  $('diff-badge').textContent = `D${state.difficulty}`;
  $('target-prefix').textContent = `${'0'.repeat(state.difficulty)}${'*'.repeat(28)}…`;
  $('rig-coin').textContent = coin.ticker;
  $('metric-blocks-label').textContent = coin.collectible ? 'FINDS' : 'BLOCKS';
  $('metric-earned-label').textContent = coin.collectible ? 'COLLECTED' : 'EARNED';
  $('foot-line').textContent = coin.collectible
    ? `PokeMine Red — collecting ${coin.name} (${coin.ticker})`
    : `PokeMine Red — mining ${coin.name} (${coin.ticker})`;

  renderRail();
  renderChain();
  renderWallet();
  renderAddress();
  renderScanner();
  renderPrice();

  if (!silent) log('system', `[SYSTEM] currency ${coin.name} (${coin.ticker}) selected`);

  await connect(coin, { silent: true });
  updatePrice();
  configureFor(coin);
  if (wasMining) startMining();
}

/* --------------------------------------------------------------------- wiring */

$('mine-btn').addEventListener('click', () => {
  if (state.mining) {
    stopMining();
    log('system', '[RIG] stopped');
  } else {
    startMining();
  }
});

$('reseed-btn').addEventListener('click', () => {
  const coin = activeCoin();
  delete walletFor(coin.id).tip;
  saveWallet();
  const was = state.mining;
  miner.stop();
  configureFor(coin);
  if (was) miner.start();
  log('system', '[RIG] header re-anchored to the live chain tip');
});

$('difficulty-range').addEventListener('input', (event) => {
  state.difficulty = Number(event.target.value);
  activeCoin().difficulty = state.difficulty;
  $('difficulty-label').textContent = `D${state.difficulty}`;
  $('diff-badge').textContent = `D${state.difficulty}`;
  $('target-prefix').textContent = `${'0'.repeat(state.difficulty)}${'*'.repeat(28)}…`;
  const was = state.mining;
  miner.stop();
  configureFor(activeCoin());
  if (was) miner.start();
  log('system', `[RIG] difficulty set to D${state.difficulty} — expected ${shortNumber(16 ** state.difficulty)} hashes per block`);
});

$('boost-range').addEventListener('input', (event) => {
  state.boost = Number(event.target.value);
  miner.setBoost(state.boost);
  $('boost-label').textContent = `${state.boost.toFixed(1)}x`;
  updateHud();
});

$('address-save').addEventListener('click', () => {
  const coin = activeCoin();
  const value = $('address-input').value.trim();
  if (!value) return;
  state.addresses[coin.id] = value;
  save(LS.address, state.addresses);
  const was = state.mining;
  miner.stop();
  configureFor(coin);
  if (was) miner.start();
  log('system', `[WALLET] coinbase set to ${value.slice(0, 18)}…`);
});

$('keypair-new').addEventListener('click', () => newKeypair());

$('keypair-reveal').addEventListener('click', () => {
  state.revealKey = !state.revealKey;
  renderKeypair();
  log('system', `[KEYS] ${state.revealKey ? 'private key and seed shown' : 'private key and seed hidden'} — demo key only`);
});

$('wallet-reset').addEventListener('click', () => {
  const coin = activeCoin();
  state.wallet[coin.id] = { blocks: 0, earned: '0', mined: [] };
  saveWallet();
  if (coin.adapter?.kind === 'local') {
    state.heads[coin.id] = { ...(state.heads[coin.id] || {}), height: 0, hash: null, fetchedAt: Date.now(), source: coin.source || 'local collectible' };
  }
  renderWallet();
  renderRail();
  renderChain();
  configureFor(coin);
  updateHud();
  log('warn', `[WALLET] ${coin.ticker} balance and local ${coin.collectible ? 'collection' : 'chain'} reset`);
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.remove('is-active'));
    tab.classList.add('is-active');
    hexMode = tab.dataset.mode;
    if (hexMode === 'decode' && !/^[0-9a-f\s]+$/i.test($('hex-input').value.trim())) {
      $('hex-input').value = 'C7 C3 C8 BF BE 00 A9 A1 A8 A7 00 CD BB CE';
    }
    renderHex();
  });
});

$('hex-input').addEventListener('input', renderHex);

const dialog = $('add-dialog');
$('add-coin-btn').addEventListener('click', () => dialog.showModal());
$('add-cancel').addEventListener('click', () => dialog.close());
$('add-form').addEventListener('change', (event) => {
  if (event.target.name === 'kind') {
    const field = document.querySelector('[data-chain-field]');
    field.hidden = event.target.value !== 'blockchair';
  }
});

$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const ticker = String(data.get('ticker') || '').trim().toUpperCase();
  const name = String(data.get('name') || '').trim();
  const url = String(data.get('url') || '').trim();
  const kind = String(data.get('kind') || 'mempool');
  if (!ticker || !name || !url) return;

  const coin = {
    id: `${ticker.toLowerCase().replace(/[^a-z0-9]/g, '') || 'coin'}-${Date.now().toString(36)}`,
    ticker,
    name,
    symbol: ticker,
    decimals: Math.max(0, Math.min(18, Number(data.get('decimals')) || 8)),
    baseReward: Math.max(0, Number(data.get('reward')) || 0),
    halvingEvery: 0,
    blockSeconds: Math.max(1, Number(data.get('blockSeconds')) || 600),
    difficulty: Math.max(1, Math.min(6, Number(data.get('difficulty')) || 4)),
    addressPrefix: ticker.toLowerCase().slice(0, 3),
    priceId: String(data.get('priceId') || '').trim() || null,
    color: '#22d3ee',
    custom: true,
    adapter: { kind, url, chain: String(data.get('chain') || '').trim() },
  };

  state.custom.push(coin);
  save(LS.custom, state.custom);
  state.coins.push(coin);
  dialog.close();
  form.reset();
  document.querySelector('[data-chain-field]').hidden = true;
  renderRail();
  selectCoin(coin.id).then(prefetchHeads);
  log('ok', `[REGISTRY] ${coin.ticker} added via ${kind}; no code change needed`);
});

$('pool-connect').addEventListener('click', async () => {
  const body = {
    host: $('pool-host').value.trim(),
    port: Number($('pool-port').value),
    user: $('pool-user').value.trim(),
    pass: $('pool-pass').value || 'x',
    suggest: Number($('pool-suggest').value) || 0.001,
  };
  if (!body.user) {
    log('err', '[POOL] put your payout address in USERNAME first — the pool credits that address');
    return;
  }
  $('pool-state').textContent = 'connecting';
  try {
    const response = await fetch('/api/pool/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error);
    pool.running = true;
    log('system', `[POOL] connecting to ${body.host}:${body.port} as ${body.user.slice(0, 14)}…`);
    log('system', '[POOL] shares are real; a block is not. Expect no payout at this hashrate.');
    startPoolPolling();
    pollPool();
  } catch (error) {
    $('pool-state').textContent = 'error';
    log('err', `[POOL] ${error.message}`);
  }
});

$('pool-disconnect').addEventListener('click', async () => {
  if (pool.worker) pool.worker.stop();
  pool.running = false;
  pool.jobId = null;
  try {
    await fetch('/api/pool/stop', { method: 'POST' });
  } catch {
    /* the server may already be gone */
  }
  log('system', '[POOL] disconnected');
  pollPool();
});

/* ----------------------------------------------------------------------- boot */

buildHexTable();
renderHex();
renderRail();
renderWallet();
renderScanner();
renderAddress();
newKeypair({ quiet: true });
updateMemory();
log('system', '[SYSTEM] PokeMine Red v2.0 initialized');
log('system', '[SYSTEM] Gen-3 hex table loaded');
log('system', '[SYSTEM] adapters: mempool · blockchair · json-rpc');
log('system', '[SYSTEM] pool bridge ready — set a payout address and connect');
log('system', '[SYSTEM] ready to mine — pick a currency above');
selectCoin(state.activeId, { silent: true });
prefetchHeads();

setInterval(() => {
  const coin = activeCoin();
  if (coin && !state.mining) connect(coin, { silent: true });
}, 90000);

setInterval(updatePrice, 120000);
