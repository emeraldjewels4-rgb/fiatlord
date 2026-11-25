// Behavioural checks for build/site-fiatlord.worker.js.
//
// The worker is what makes the published page work at all: the prices route the
// dashboard polls, the 501 JSON that stops it parsing the SPA shell as an
// answer, and the cache headers that keep a hashed bundle from being re-fetched
// while the shell stays revalidated. None of that is visible in the staged tree,
// so staging alone cannot catch a regression in it. These checks run from
// build/make_site_fiatlord.py --check and fail the staging run when the worker
// stops behaving the way the deployed page depends on.
//
// Also runnable on its own:
//     node build/check_site_worker.mjs
//
// Each case imports the worker afresh under a cache-busting query, so every case
// gets its own module scope and one case's carried snapshot cannot leak into the
// next. The only things stubbed are what the worker reaches outside itself: the
// upstream ticker (global fetch), env.ASSETS.fetch, the D1 binding, and the
// execution context whose waitUntil carries the background snapshot mirror.
// Nothing here touches the network or the project files beyond importing the
// worker.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { computeWorkerId } from "./worker-id.mjs";

const WORKER = new URL("./site-fiatlord.worker.js", import.meta.url);

const SHELL = "<!doctype html><title>FiatLord live crypto dashboard</title>";
const IMMUTABLE = "public, max-age=31536000, immutable";
const SHELL_CACHE = "no-cache";
const UNIMPLEMENTED = "CoinSpot signing is not available on this host";
const TICKER_V2 = "https://www.coinspot.com.au/pubapi/v2/latest";
const TICKER_V1 = "https://www.coinspot.com.au/pubapi/latest";

const failures = [];
let checks = 0;

function check(name, ok, detail = "") {
  checks += 1;
  // Plain ASCII punctuation on purpose: this text is printed through the
  // Windows console code page by the staging script, which mangles dashes.
  if (!ok) failures.push(`${name}: ${detail || "failed"}`);
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function num(name, actual, expected) {
  check(name, actual === expected && typeof actual === "number",
    `expected number ${expected}, got ${typeof actual} ${JSON.stringify(actual)}`);
}

function isJson(res) {
  return (res.headers.get("content-type") || "").startsWith("application/json");
}

// What the deployed host does: a file it has is served with its own headers,
// and anything else comes back as the SPA shell with a 200. The shell-under-an-
// asset-URL case is real, not a contrivance, so the stub reproduces it.
function host(routes = {}) {
  const calls = [];
  return {
    calls,
    ASSETS: {
      async fetch(request) {
        const { pathname } = new URL(request.url);
        calls.push(pathname);
        const hit = routes[pathname];
        if (!hit) {
          return new Response(SHELL, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        return new Response(hit.body ?? null, {
          status: hit.status ?? 200,
          headers: hit.headers ?? {},
        });
      },
    },
  };
}

// The site's D1 binding, as much of it as the worker uses: prepare().bind().run()
// and prepare().first(). `row` is what the snapshot table holds, or null for an
// empty table. It is a small table, not a canned answer: an INSERT updates the
// row, which is what lets the worker's read-after-write see what it just wrote.
// Every statement is recorded so a test can assert the write.
function storage(row = null) {
  const calls = [];
  const state = { row };
  const db = {
    prepare(sql) {
      const call = { sql, args: null };
      calls.push(call);
      const statement = {
        bind(...args) {
          call.args = args;
          return statement;
        },
        async run() {
          if (/INSERT (OR REPLACE )?INTO price_snapshot/.test(sql) && call.args) {
            state.row = { fetched_at: call.args[0], prices: call.args[1] };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          return state.row;
        },
      };
      return statement;
    },
  };
  return { db, calls, state };
}

function ticker(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
const realNow = Date.now;
let fakeNow = null;   // null follows the wall clock; a number pins it
Date.now = () => (fakeNow === null ? realNow() : fakeNow);

let loads = 0;
async function load() {
  loads += 1;
  const mod = await import(`${WORKER.href}?case=${loads}`);
  return mod.default;
}

function fetching(handler) {
  globalThis.fetch = handler;
  return () => { globalThis.fetch = realFetch; };
}

// The worker schedules its D1 mirror through ctx.waitUntil. The test holds those
// promises instead of settling them inside call(), because whether the answer
// arrived before the mirror finished is exactly what the latency checks measure.
async function call(worker, path, { method = "GET", env = host({}), ctx } = {}) {
  const response = await worker.fetch(
    new Request(`https://fiatlord.example${path}`, { method }),
    env,
    ctx,
  );
  return { response, body: await response.text() };
}

function execution() {
  const pending = [];
  return {
    ctx: {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    },
    pending,
    async settle() {
      while (pending.length > 0) await pending.shift();
    },
  };
}

// Parsing is the assertion here: the whole point of the 501 and 502 branches is
// that the dashboard never gets HTML where it expects JSON, so a body that will
// not parse fails a check instead of aborting the run with a stack trace.
function jsonBody(name, response, text) {
  try {
    return JSON.parse(text);
  } catch {
    check(`${name}: answer is JSON`, false, `${response.status} ` +
      `${response.headers.get("content-type")} ${JSON.stringify(text.slice(0, 40))}`);
    return {};
  }
}

const CHECKED_TICKER = {
  status: "ok",
  prices: {
    btc: { bid: "93000", ask: "93100", last: "93050" },
    sol: { bid: "100", ask: "102" },
    eth: { last: "0" },                       // no usable number, must be skipped
    xrp: { bid: "1.40", ask: "1.42", last: "1.41" },
  },
};

// --- prices -----------------------------------------------------------------

{
  const worker = await load();
  const seen = [];
  const restore = fetching(async (url, init) => {
    seen.push({ url: String(url), accept: init?.headers?.accept });
    return ticker(CHECKED_TICKER);
  });
  const { response, body: text } = await call(worker, "/api/coinspot/prices");
  restore();

  const body = jsonBody("prices", response, text);
  eq("prices status", response.status, 200);
  check("prices content type", isJson(response), response.headers.get("content-type"));
  eq("prices cache", response.headers.get("cache-control"), "no-store");
  eq("prices ok", body.ok, true);
  check("prices missing is empty", Array.isArray(body.missing) && body.missing.length === 0,
    JSON.stringify(body.missing));
  check("prices fetchedAt is a number", typeof body.fetchedAt === "number" && body.fetchedAt > 0,
    String(body.fetchedAt));

  num("prices btc last", body.prices?.btc?.last, 93050);
  num("prices btc bid", body.prices?.btc?.bid, 93000);
  num("prices btc ask", body.prices?.btc?.ask, 93100);
  num("prices sol last is the midpoint", body.prices?.sol?.last, 101);
  num("prices sol bid", body.prices?.sol?.bid, 100);
  num("prices sol ask", body.prices?.sol?.ask, 102);
  check("prices drop a quote with no usable number", body.prices?.eth === undefined,
    JSON.stringify(body.prices?.eth));
  check("prices are keyed by lower-case code", body.prices?.BTC === undefined &&
    body.prices?.btc !== undefined);
  eq("an ordinary answer carries no diagnostic", body.diag, undefined);

  eq("prices ask the v2 ticker", seen[0]?.url, TICKER_V2);
  eq("prices ask for JSON", seen[0]?.accept, "application/json");
  eq("prices call the ticker once", seen.length, 1);
}

{
  // The price route must be answered here and never handed to the assets
  // binding. If it were, the host would answer with the shell and a 200, the
  // page would fail to parse prices, and the live dashboard would quietly fall
  // back to its simulated feed. The stub counts the fallback rather than just
  // returning the shell, so a regression is named instead of inferred.
  const worker = await load();
  let fallbacks = 0;
  const env = {
    ASSETS: {
      async fetch() {
        fallbacks += 1;
        return new Response(SHELL, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  };
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  const { response, body: text } = await call(worker, "/api/coinspot/prices", { env });
  restore();

  eq("prices are served by the worker, not the fallback", fallbacks, 0);
  eq("prices never fall through status", response.status, 200);
  check("prices never fall through is JSON", isJson(response),
    response.headers.get("content-type"));
  const body = jsonBody("prices never fall through", response, text);
  eq("prices never fall through ok", body.ok, true);
  num("prices never fall through btc", body.prices?.btc?.last, 93050);
}

{
  // A ticker that answers 5xx falls through to the next one rather than failing.
  const worker = await load();
  const seen = [];
  const restore = fetching(async (url) => {
    seen.push(String(url));
    if (String(url) === TICKER_V2) return new Response("down", { status: 503 });
    return ticker(CHECKED_TICKER);
  });
  const { response, body: text } = await call(worker, "/api/coinspot/prices");
  restore();

  eq("prices fall back to the v1 ticker", seen[1], TICKER_V1);
  eq("prices survive one dead ticker", response.status, 200);
  eq("prices survive with a body", jsonBody("prices fallback", response, text).ok, true);
}

{
  // Within FRESH_MS the previous answer is reused: this is what keeps a 15 s
  // poll from spending a request upstream every tick.
  const worker = await load();
  let upstream = 0;
  const restore = fetching(async () => {
    upstream += 1;
    return ticker(CHECKED_TICKER);
  });
  const a = await call(worker, "/api/coinspot/prices");
  const first = jsonBody("prices first", a.response, a.body);
  fakeNow = first.fetchedAt + 5_000;
  const b = await call(worker, "/api/coinspot/prices");
  const second = jsonBody("prices reused", b.response, b.body);
  eq("prices reuse a fresh snapshot", upstream, 1);
  eq("prices reuse keeps fetchedAt", second.fetchedAt, first.fetchedAt);

  fakeNow = first.fetchedAt + 11_000;
  const c = await call(worker, "/api/coinspot/prices");
  const third = jsonBody("prices refreshed", c.response, c.body);
  eq("prices refresh a stale snapshot", upstream, 2);
  check("prices refresh moves fetchedAt", third.fetchedAt > first.fetchedAt);
  restore();
}

{
  // Upstream gone, snapshot still held: the route replays it and says so, which
  // is how the page tells stale-but-real prices from nothing at all.
  const worker = await load();
  let restore = fetching(async () => ticker(CHECKED_TICKER));
  const firstCall = await call(worker, "/api/coinspot/prices");
  const first = jsonBody("carried first", firstCall.response, firstCall.body);
  restore();

  restore = fetching(async () => { throw new Error("offline"); });
  fakeNow = first.fetchedAt + 60_000;
  const { response, body: text } = await call(worker, "/api/coinspot/prices");
  restore();

  const body = jsonBody("carried", response, text);
  eq("carried status", response.status, 200);
  eq("carried ok", body.ok, true);
  eq("carried marked as carried", body.prices?.btc?.source, "carried");
  eq("carried at the snapshot time", body.prices?.btc?.carriedAt, first.fetchedAt);
  num("carried keeps the last price", body.prices?.btc?.last, 93050);
}

{
  // A cold start is a fresh module scope: nothing carried in memory and the
  // upstream gone. What an earlier isolate wrote to the site's database is then
  // the only thing that can keep real prices on a just-booted page.
  const stored = {
    fetched_at: Date.now() - 30_000,
    prices: JSON.stringify({ btc: { last: 90000, bid: 89900, ask: 90100 } }),
  };
  const store = storage(stored);
  const worker = await load();
  const restore = fetching(async () => { throw new Error("offline"); });
  const { response, body: text } = await call(worker, "/api/coinspot/prices",
    { env: { ...host({}), DB: store.db } });
  restore();

  const body = jsonBody("cold carried", response, text);
  eq("cold start answers from storage", response.status, 200);
  eq("cold start marks the price carried", body.prices?.btc?.source, "carried");
  eq("cold start keeps the stored time", body.prices?.btc?.carriedAt, stored.fetched_at);
  num("cold start keeps the stored price", body.prices?.btc?.last, 90000);
  check("cold start reads the snapshot table",
    store.calls.some((c) => /SELECT fetched_at, prices FROM price_snapshot/.test(c.sql)),
    JSON.stringify(store.calls.map((c) => c.sql)));
  // Table creation is part of the background mirror, not the read: a cold start
  // must not spend a schema round trip only to find the table empty.
  check("cold start does not create the snapshot table",
    !store.calls.some((c) => /CREATE TABLE/.test(c.sql)),
    JSON.stringify(store.calls.map((c) => c.sql)));
  eq("cold start reads before anything else", /^SELECT/.test(store.calls[0]?.sql ?? ""), true);
}

{
  // What a curl cannot otherwise see: a host that already holds a price never
  // reads the stored row, so its 200 proves nothing about storage. The probe
  // forces exactly the cold-start steps and answers what a just-booted host
  // would serve, with the age it would have carried.
  // Pinned, so the reported age is the arithmetic and not however many
  // milliseconds the test itself took.
  fakeNow = realNow();
  const stored = {
    fetched_at: fakeNow - 45_000,
    prices: JSON.stringify({ btc: { last: 90000, bid: 89900, ask: 90100 } }),
  };
  const store = storage(stored);
  const worker = await load();
  let upstream = 0;
  const restore = fetching(async () => {
    upstream += 1;
    return ticker(CHECKED_TICKER);
  });
  const { response, body: text } = await call(worker, "/api/coinspot/prices?diag=stored",
    { env: { ...host({}), DB: store.db } });
  restore();

  const body = jsonBody("stored probe", response, text);
  eq("stored probe status", response.status, 200);
  eq("stored probe is the diagnostic", body.diag, "stored");
  eq("stored probe names its source", body.source, "stored");
  eq("stored probe reports an empty host", body.isolate, "cold");
  eq("stored probe does not poll the ticker", upstream, 0);
  num("stored probe keeps the stored price", body.prices?.btc?.last, 90000);
  eq("stored probe marks the price carried", body.prices?.btc?.source, "carried");
  eq("stored probe keeps the stored time", body.carriedAt, stored.fetched_at);
  eq("stored probe keeps the stored age", body.ageMs, 45_000);
  eq("stored probe reports the row it read", body.stored?.present, true);
  eq("stored probe reports the row's age", body.stored?.ageMs, 45_000);
  check("stored probe reads the snapshot table",
    store.calls.some((c) => /SELECT fetched_at, prices FROM price_snapshot/.test(c.sql)),
    JSON.stringify(store.calls.map((c) => c.sql)));
  check("stored probe writes nothing",
    !store.calls.some((c) => /^\s*(INSERT|CREATE|DELETE|UPDATE)/i.test(c.sql)),
    JSON.stringify(store.calls.map((c) => c.sql)));
}

{
  // The probe reads storage even when the host already holds a price, which is
  // what makes it a storage check rather than a replay of memory: the row's
  // 90000 differs from the ticker's 93050, and the host reports itself warm.
  fakeNow = null;
  const stored = {
    fetched_at: Date.now() - 20_000,
    prices: JSON.stringify({ btc: { last: 90000, bid: 89900, ask: 90100 } }),
  };
  const store = storage(stored);
  const worker = await load();
  let restore = fetching(async () => ticker(CHECKED_TICKER));
  await call(worker, "/api/coinspot/prices", { env: host({}) });
  restore();

  const { response, body: text } = await call(worker, "/api/coinspot/prices?diag=stored",
    { env: { ...host({}), DB: store.db } });
  const body = jsonBody("warm stored probe", response, text);
  eq("a warm host still answers the probe", response.status, 200);
  eq("a warm host is reported as such", body.isolate, "warm");
  num("a warm host's probe reads the row, not memory", body.prices?.btc?.last, 90000);
  eq("a warm host's probe says stored", body.source, "stored");
}

{
  // Nothing to probe with: the probe has to say which of the two reasons it is,
  // since "no row" and "no database" are different things to fix.
  fakeNow = null;
  const worker = await load();
  const restore = fetching(async () => ticker(CHECKED_TICKER));

  const empty = storage(null);
  const none = await call(worker, "/api/coinspot/prices?diag=stored",
    { env: { ...host({}), DB: empty.db } });
  const noneBody = jsonBody("empty stored probe", none.response, none.body);
  eq("a probe with no row answers 502", none.response.status, 502);
  eq("a probe with no row names its source", noneBody.source, "none");
  eq("a probe with no row says there is no row", noneBody.error, "no stored row");
  eq("a probe with no row reports no row", noneBody.stored?.present, false);
  eq("a probe with no row reports no age", noneBody.stored?.ageMs, null);
  eq("a probe with no row carries no prices", noneBody.prices, undefined);
  check("an empty probe reads only",
    empty.calls.every((c) => /^\s*SELECT/i.test(c.sql)),
    JSON.stringify(empty.calls.map((c) => c.sql)));

  const unbound = await call(worker, "/api/coinspot/prices?diag=stored", { env: host({}) });
  const unboundBody = jsonBody("unbound stored probe", unbound.response, unbound.body);
  eq("a probe without a database answers 502", unbound.response.status, 502);
  eq("a probe without a database says so", unboundBody.error, "no DB binding");

  restore();
}

{
  // An expired row and an empty table both answer 502, but they are different
  // states: the row is still there, only ignored. The probe has to say which one
  // it found, because "the window is doing its job" and "nothing was ever
  // stored" cannot be told apart from the outside otherwise.
  fakeNow = realNow();
  const staleRow = {
    fetched_at: fakeNow - 10 * 60_000,
    prices: JSON.stringify({ btc: { last: 90000 } }),
  };
  const stale = storage(staleRow);
  const worker = await load();
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  const old = await call(worker, "/api/coinspot/prices?diag=stored",
    { env: { ...host({}), DB: stale.db } });
  restore();

  const oldBody = jsonBody("stale stored probe", old.response, old.body);
  eq("a probe ignores a row outside the window", old.response.status, 502);
  eq("an expired probe names its source", oldBody.source, "none");
  eq("an expired probe still sees the row", oldBody.stored?.present, true);
  eq("an expired probe reports the row's age", oldBody.stored?.ageMs, 10 * 60_000);
  eq("an expired probe says the age is the reason", oldBody.error,
    "stored row is older than 5 minutes");
  eq("an expired probe carries no prices", oldBody.prices, undefined);
  eq("an expired probe carries no stored time", oldBody.carriedAt, undefined);
  check("an expired probe reads only",
    stale.calls.every((c) => /^\s*SELECT/i.test(c.sql)),
    JSON.stringify(stale.calls.map((c) => c.sql)));
  eq("an expired probe leaves the row untouched", stale.state.row?.fetched_at,
    staleRow.fetched_at);
  eq("an expired probe writes no snapshot", oldBody.snapshot?.state, "idle");
  check("an expired probe does not create the table",
    !stale.calls.some((c) => /CREATE TABLE/.test(c.sql)),
    JSON.stringify(stale.calls.map((c) => c.sql)));
  fakeNow = null;
}

{
  // A mistyped flag must not look like a working probe: the answer names the one
  // value it knows instead of falling through to a live 200.
  const worker = await load();
  let upstream = 0;
  const restore = fetching(async () => {
    upstream += 1;
    return ticker(CHECKED_TICKER);
  });
  const { response, body: text } = await call(worker, "/api/coinspot/prices?diag=store",
    { env: host({}) });
  restore();

  const body = jsonBody("unknown diag", response, text);
  eq("an unknown diag is refused", response.status, 400);
  eq("an unknown diag names the accepted value", body.accepted, "stored");
  eq("an unknown diag does not poll", upstream, 0);
}

{
  // A stored row can be any age, and a revived isolate has no way to tell a row
  // written seconds ago from one written before a long outage. Old prices shown
  // as real are worse than no prices, so the window is checked at both ends; the
  // exact limit belongs to the worker, so this pins "a few minutes" loosely.
  const prices = JSON.stringify({ btc: { last: 90000, bid: 89900, ask: 90100 } });
  for (const { label, age, carried } of [
    { label: "two-minute", age: 2 * 60_000, carried: true },
    { label: "ten-minute", age: 10 * 60_000, carried: false },
    { label: "week", age: 7 * 24 * 60 * 60_000, carried: false },
  ]) {
    const store = storage({ fetched_at: Date.now() - age, prices });
    const worker = await load();
    const restore = fetching(async () => { throw new Error("offline"); });
    const { response, body: text } = await call(worker, "/api/coinspot/prices",
      { env: { ...host({}), DB: store.db } });
    restore();
    const body = jsonBody(`row aged ${label}`, response, text);

    if (carried) {
      eq(`a ${label}-old row is carried`, response.status, 200);
      eq(`a ${label}-old row is marked carried`, body.prices?.btc?.source, "carried");
      num(`a ${label}-old row keeps its price`, body.prices?.btc?.last, 90000);
    } else {
      eq(`a ${label}-old row is ignored`, response.status, 502);
      eq(`a ${label}-old row states why`, body.error, "price feed unavailable");
      eq(`a ${label}-old row carries no prices`, body.prices, undefined);
    }
    // Ignored means ignored, not cleaned up: the row belongs to the mirror, and
    // deleting it would mean a second write behind a request that failed.
    check(`a ${label}-old row is left in storage`,
      !store.calls.some((c) => /^\s*(DELETE|UPDATE)/i.test(c.sql)),
      JSON.stringify(store.calls.map((c) => c.sql)));
  }
}

{
  // Nothing stored and nothing to ask: still the JSON 502 the page expects.
  const store = storage(null);
  const worker = await load();
  const restore = fetching(async () => { throw new Error("offline"); });
  const { response, body: text } = await call(worker, "/api/coinspot/prices",
    { env: { ...host({}), DB: store.db } });
  restore();

  eq("cold start without storage answers 502", response.status, 502);
  eq("cold start without storage says why",
    jsonBody("cold unpriced", response, text).error, "price feed unavailable");
}

{
  // Storage that fails is a lost fallback, not a broken feed: the route still
  // has to answer JSON rather than throwing.
  const worker = await load();
  const restore = fetching(async () => { throw new Error("offline"); });
  const { response, body: text } = await call(worker, "/api/coinspot/prices",
    { env: { ...host({}), DB: { prepare() { throw new Error("no such binding"); } } } });
  restore();

  eq("a failing snapshot store still answers 502", response.status, 502);
  eq("a failing snapshot store answers JSON",
    jsonBody("broken store", response, text).ok, false);
}

{
  // A good fetch is written through, which is what gives the next cold isolate
  // something to carry. The write is scheduled after the answer, so the test
  // settles the context before looking for it, then asks again to read what the
  // answer can report: the mirror's outcome lives in the `snapshot` field.
  fakeNow = null;
  const store = storage(null);
  const exec = execution();
  const worker = await load();
  const env = { ...host({}), DB: store.db };
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  const { response, body: text } = await call(worker, "/api/coinspot/prices",
    { env, ctx: exec.ctx });

  const first = jsonBody("write-through", response, text);
  eq("a good fetch schedules one mirror", exec.pending.length, 1);
  eq("the answer admits the mirror is still running", first.snapshot?.state, "pending");
  await exec.settle();

  const write = store.calls.find((c) => /INSERT (OR REPLACE )?INTO price_snapshot/.test(c.sql));
  check("a good fetch is written to storage", Boolean(write),
    JSON.stringify(store.calls.map((c) => c.sql)));
  check("the mirror creates the table it writes",
    store.calls.some((c) => /CREATE TABLE IF NOT EXISTS price_snapshot/.test(c.sql)),
    JSON.stringify(store.calls.map((c) => c.sql)));
  eq("the write carries the fetch time", write?.args?.[0], first.fetchedAt);
  check("the write carries the prices", String(write?.args?.[1] ?? "").includes('"btc"'),
    String(write?.args?.[1] ?? "").slice(0, 60));
  eq("the stored row holds the fetch time", store.state.row?.fetched_at, first.fetchedAt);
  check("the mirror reads the row back",
    store.calls.some((c) => /SELECT fetched_at, prices FROM price_snapshot/.test(c.sql)),
    JSON.stringify(store.calls.map((c) => c.sql)));

  const again = await call(worker, "/api/coinspot/prices", { env, ctx: exec.ctx });
  const reported = jsonBody("write-through reported", again.response, again.body);
  restore();
  eq("the next answer reports the write", reported.snapshot?.state, "written");
  eq("the report names the stored time", reported.snapshot?.fetchedAt, first.fetchedAt);
  eq("the report counts the row", reported.snapshot?.changes, 1);
  eq("the report does not invent an error", reported.snapshot?.error, undefined);
}

{
  // Without a binding there is nothing to mirror into, and the answer has to say
  // so rather than looking exactly like a successful write.
  fakeNow = null;
  const worker = await load();
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  const { response, body: text } = await call(worker, "/api/coinspot/prices");
  restore();

  const body = jsonBody("unbound", response, text);
  eq("no binding still answers prices", response.status, 200);
  eq("no binding is reported", body.snapshot?.state, "unbound");
}

{
  // The swallowed failure, now reported: a database that throws leaves the feed
  // untouched but the answer says the row was not written, and why.
  fakeNow = null;
  const exec = execution();
  const worker = await load();
  const env = { ...host({}), DB: { prepare() { throw new Error("no such binding"); } } };
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  const { response, body: text } = await call(worker, "/api/coinspot/prices",
    { env, ctx: exec.ctx });
  const first = jsonBody("failing write", response, text);
  await exec.settle();
  const again = await call(worker, "/api/coinspot/prices", { env, ctx: exec.ctx });
  restore();

  const body = jsonBody("failing write reported", again.response, again.body);
  eq("a failing write still serves prices", response.status, 200);
  eq("a failing write starts as pending", first.snapshot?.state, "pending");
  eq("a failing write is reported", body.snapshot?.state, "failed");
  check("the failure keeps its reason",
    String(body.snapshot?.error ?? "").includes("no such binding"),
    JSON.stringify(body.snapshot?.error));
}

{
  // A run() that resolves is not a row. The mirror reads the row back, so a
  // statement the engine accepted but did not store is reported as a failure.
  fakeNow = null;
  const exec = execution();
  const worker = await load();
  const db = {
    prepare() {
      const statement = {
        bind() { return statement; },
        async run() { return { success: true, meta: { changes: 1 } }; },
        async first() { return null; },
      };
      return statement;
    },
  };
  const env = { ...host({}), DB: db };
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  await call(worker, "/api/coinspot/prices", { env, ctx: exec.ctx });
  await exec.settle();
  const again = await call(worker, "/api/coinspot/prices", { env, ctx: exec.ctx });
  restore();

  const body = jsonBody("unconfirmed write reported", again.response, again.body);
  eq("an unconfirmed write is reported as failed", body.snapshot?.state, "failed");
  check("an unconfirmed write says the row is missing",
    String(body.snapshot?.error ?? "").includes("no row"),
    JSON.stringify(body.snapshot?.error));
}

{
  // A cold 502 has nothing to report yet, and has to say that rather than
  // pretend: the field is always present, so a reader can tell "no attempt"
  // apart from "wrote" without the key vanishing on one branch.
  fakeNow = null;
  const worker = await load();
  const restore = fetching(async () => { throw new Error("offline"); });
  const { response, body: text } = await call(worker, "/api/coinspot/prices",
    { env: { ...host({}), DB: { prepare() { throw new Error("no such binding"); } } } });
  restore();

  const body = jsonBody("cold unpriced report", response, text);
  eq("the 502 is still a 502", response.status, 502);
  eq("the 502 says no write was attempted", body.snapshot?.state, "idle");
  eq("the 502 invents no error", body.snapshot?.error, undefined);
}

{
  // The point of scheduling the mirror: a database that never answers must never
  // hold an answer back. The store blocks until the test opens it, so a worker
  // that awaited the write could not produce a response at all.
  const worker = await load();
  const exec = execution();
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  const seen = [];
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const db = {
    prepare(sql) {
      seen.push(sql);
      const statement = {
        bind() { return statement; },
        async run() { await gate; return { success: true }; },
        async first() { await gate; return null; },
      };
      return statement;
    },
  };

  let slow = false;
  const timer = setTimeout(() => { slow = true; open(); }, 1000);
  const { response, body: text } = await call(worker, "/api/coinspot/prices",
    { env: { ...host({}), DB: db }, ctx: exec.ctx });
  clearTimeout(timer);
  const body = jsonBody("blocked store", response, text);

  check("a blocked database does not delay the answer", !slow,
    "the price response waited on the snapshot mirror");
  eq("a blocked database still answers prices", response.status, 200);
  num("a blocked database still returns the quote", body.prices?.btc?.last, 93050);
  eq("the blocked mirror is still held for completion", exec.pending.length, 1);

  open();
  await exec.settle();
  restore();
  check("the mirror writes once the database answers",
    seen.some((sql) => /INSERT (OR REPLACE )?INTO price_snapshot/.test(sql)),
    JSON.stringify(seen));
}

{
  // A database that fails has to cost the carry-over and nothing else: the feed
  // answers first regardless, and the scheduled work must not turn into an
  // unhandled rejection after the response is gone.
  const worker = await load();
  const exec = execution();
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  const { response, body: text } = await call(worker, "/api/coinspot/prices", {
    env: { ...host({}), DB: { prepare() { throw new Error("no such binding"); } } },
    ctx: exec.ctx,
  });
  restore();

  eq("a failing mirror still answers prices", response.status, 200);
  eq("a failing mirror still answers ok", jsonBody("failing mirror", response, text).ok, true);
  let settled = false;
  try {
    await exec.settle();
    settled = true;
  } catch {
    // reported below
  }
  check("a failing mirror does not reject the scheduled work", settled);
}

{
  // Without an execution context (a plain fetch, as some local tooling does) the
  // mirror still runs; only the guarantee of finishing after the response goes.
  const store = storage(null);
  const worker = await load();
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  await call(worker, "/api/coinspot/prices", { env: { ...host({}), DB: store.db } });
  restore();
  await new Promise((resolve) => setTimeout(resolve, 0));

  check("a mirror without an execution context still writes",
    store.calls.some((c) => /INSERT (OR REPLACE )?INTO price_snapshot/.test(c.sql)),
    JSON.stringify(store.calls.map((c) => c.sql)));
}

{
  // No upstream and no snapshot: 502 JSON, so the page falls back to its
  // simulated feed instead of parsing HTML.
  const worker = await load();
  const restore = fetching(async () => { throw new Error("offline"); });
  const { response, body: text } = await call(worker, "/api/coinspot/prices");
  restore();

  const body = jsonBody("unpriced", response, text);
  eq("unpriced status", response.status, 502);
  check("unpriced content type", isJson(response), response.headers.get("content-type"));
  eq("unpriced cache", response.headers.get("cache-control"), "no-store");
  eq("unpriced ok", body.ok, false);
  eq("unpriced error", body.error, "price feed unavailable");
  check("unpriced is not the shell", !text.startsWith("<!doctype"), text.slice(0, 40));
}

{
  const worker = await load();
  let upstream = 0;
  const restore = fetching(async () => {
    upstream += 1;
    return ticker(CHECKED_TICKER);
  });
  const { response, body: text } = await call(worker, "/api/coinspot/prices", { method: "POST" });
  restore();

  const body = jsonBody("prices refusal", response, text);
  eq("prices refuse other methods", response.status, 405);
  eq("prices refusal is JSON", body.error, "method not allowed");
  eq("prices refusal does not poll", upstream, 0);

  const probe = await call(worker, "/api/coinspot/prices?diag=stored", { method: "POST" });
  eq("the probe keeps the method refusal", probe.response.status, 405);
}

// --- build identity ----------------------------------------------------------

{
  // The other half of the diagnostic pair: `?diag=stored` says where the prices
  // came from, this says what is serving them. The worker cannot know its own
  // commit -- a deployment uploads the file verbatim -- so it carries a hash of
  // its own source, and reports the shell's hash for the page it serves. Both
  // are recomputed from the clone, so one call compares deployment with source.
  const source = readFileSync(WORKER, "utf8");
  const expected = computeWorkerId(source);
  const shellHash = createHash("sha256").update(SHELL, "utf8").digest("hex").slice(0, 12);

  // A fresh isolate: pageId caches per module scope, so this would otherwise
  // see the value the next block computes.
  const bare = await call(await load(), "/api/version", { env: {} });
  const bareBody = jsonBody("version without assets", bare.response, bare.body);
  eq("version without an assets binding still answers", bare.response.status, 200);
  eq("version without assets reports no page id", bareBody.assets, null);
  eq("version without assets keeps the worker id", bareBody.worker, expected);

  const worker = await load();
  const store = storage(null);
  const env = { ...host({}), DB: store.db };
  let upstream = 0;
  const restore = fetching(async () => {
    upstream += 1;
    return ticker(CHECKED_TICKER);
  });
  const first = await call(worker, "/api/version", { env });
  const second = await call(worker, "/api/version", { env });
  restore();

  const body = jsonBody("version", first.response, first.body);
  eq("version answers 200 rather than the 501", first.response.status, 200);
  eq("version says ok", body.ok, true);
  eq("version reports the worker's content id", body.worker, expected);
  check("the worker id looks like a content id",
    /^[0-9a-f]{12}$/.test(String(body.worker)), JSON.stringify(body.worker));
  eq("version reports the shell's hash", body.assets, shellHash);
  eq("version does not poll the ticker", upstream, 0);
  eq("version does not touch the database", store.calls.length, 0);
  check("version reads the shell once per isolate",
    env.calls.filter((p) => p === "/index.html").length === 1, JSON.stringify(env.calls));
  const again = jsonBody("version repeat", second.response, second.body);
  eq("version repeats the same page id", again.assets, shellHash);

  const post = await call(worker, "/api/version", { method: "POST" });
  eq("version keeps the method refusal", post.response.status, 405);
}

// --- unimplemented /api paths -----------------------------------------------

{
  const worker = await load();
  for (const path of [
    "/api",
    "/api/",
    "/api/coinspot/balance",
    "/api/coinspot/sell",
    "/api/coinspot/sell-quote",
    "/api/coinspot/deposit",
    "/api/whatever",
  ]) {
    const { response, body: text } = await call(worker, path);
    const body = jsonBody(path, response, text);
    eq(`${path} status`, response.status, 501);
    check(`${path} content type`, isJson(response), response.headers.get("content-type"));
    eq(`${path} cache`, response.headers.get("cache-control"), "no-store");
    eq(`${path} ok`, body.ok, false);
    eq(`${path} error reads plainly`, body.error, UNIMPLEMENTED);
    check(`${path} keeps its reason`,
      typeof body.reason === "string" && body.reason.length > 0, JSON.stringify(body.reason));
    check(`${path} is not the shell`, !text.startsWith("<!doctype"), text.slice(0, 40));
  }
}

{
  // A path does not stop being an API call because it is spelled with capitals.
  // The dashboard's own requests are lower case, so this is about every other
  // way the URL can arrive: a hand-typed one, a rewritten one, a redirect that
  // normalises case. None of them may be answered with the shell.
  const worker = await load();
  const restore = fetching(async () => ticker(CHECKED_TICKER));
  for (const path of ["/API", "/Api/", "/Api/coinspot/sell", "/Api/Coinspot/Balance"]) {
    const { response, body: text } = await call(worker, path);
    const body = jsonBody(path, response, text);
    eq(`${path} status`, response.status, 501);
    check(`${path} content type`, isJson(response), response.headers.get("content-type"));
    eq(`${path} error reads plainly`, body.error, UNIMPLEMENTED);
    check(`${path} is not the shell`, !text.startsWith("<!doctype"), text.slice(0, 40));
  }
  const upper = await call(worker, "/API/COINSPOT/PRICES");
  restore();
  const body = jsonBody("upper-case prices", upper.response, upper.body);
  eq("upper-case prices status", upper.response.status, 200);
  check("upper-case prices is JSON", isJson(upper.response),
    upper.response.headers.get("content-type"));
  num("upper-case prices btc", body.prices?.btc?.last, 93050);
}

// --- cache headers ----------------------------------------------------------

{
  const bundle = "console.log('bundle');\n";
  const env = host({
    "/assets/index-Euyfrw0y.js": {
      body: bundle,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "max-age=0",
      },
    },
  });
  const worker = await load();
  const { response, body } = await call(worker, "/assets/index-Euyfrw0y.js", { env });

  eq("asset status", response.status, 200);
  eq("asset cache", response.headers.get("cache-control"), IMMUTABLE);
  eq("asset content type", response.headers.get("content-type"), "text/javascript; charset=utf-8");
  eq("asset bytes are untouched", body, bundle);
}

{
  // The live host answers a missing /assets/ URL with the shell and a 200. The
  // header rewrite has to notice it is HTML before it notices the path, or the
  // shell gets pinned as immutable for a year under an asset URL.
  const worker = await load();
  const { response, body } = await call(worker, "/assets/index-missing.js");

  eq("shell under an asset URL status", response.status, 200);
  eq("shell under an asset URL is not immutable", response.headers.get("cache-control"), SHELL_CACHE);
  eq("shell under an asset URL is the shell", body, SHELL);
}

{
  const env = host({
    "/ads.html": {
      body: "<!doctype html><title>ad</title>",
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=600" },
    },
  });
  const worker = await load();
  for (const path of ["/", "/market/btc", "/balance", "/ads.html"]) {
    const { response, body } = await call(worker, path, { env });
    eq(`${path} status`, response.status, 200);
    eq(`${path} is revalidated`, response.headers.get("cache-control"), SHELL_CACHE);
    check(`${path} still carries a body`, body.length > 0, `${body.length} bytes`);
  }
}

{
  // Everything that is neither HTML nor a hashed asset keeps what the host gave
  // it: a redirect must not become a cached document, and a not-modified
  // plain-text file must not be relabelled.
  const env = host({
    "/robots.txt": {
      body: "User-agent: *\n",
      headers: { "content-type": "text/plain", "cache-control": "max-age=300" },
    },
    "/ads.html": {
      status: 307,
      headers: { location: "/ads", "content-type": "text/html" },
    },
    "/assets/old.js": {
      status: 304,
      headers: {
        "content-type": "text/javascript",
        "cache-control": "public, max-age=0, must-revalidate",
        etag: "\"a1b2c3\"",
      },
    },
  });
  const worker = await load();

  const robots = await call(worker, "/robots.txt", { env });
  eq("plain text keeps its status", robots.response.status, 200);
  eq("plain text keeps its cache header", robots.response.headers.get("cache-control"), "max-age=300");
  eq("plain text keeps its body", robots.body, "User-agent: *\n");

  const redirect = await call(worker, "/ads.html", { env });
  eq("redirect keeps its status", redirect.response.status, 307);
  eq("redirect keeps its target", redirect.response.headers.get("location"), "/ads");
  eq("redirect is not cached by us", redirect.response.headers.get("cache-control"), null);

  // A 304 replaces the headers the browser has stored for that URL, so the
  // immutable lifetime has to be restated on it. The host answers a conditional
  // request for an asset with `max-age=0, must-revalidate`; passed through, that
  // downgrade would undo the year the 200 granted and put every later visit back
  // to revalidating the bundle.
  const notModified = await call(worker, "/assets/old.js", { env });
  eq("not-modified keeps its status", notModified.response.status, 304);
  eq("not-modified restates the immutable lifetime",
    notModified.response.headers.get("cache-control"), IMMUTABLE);
  eq("not-modified keeps its etag", notModified.response.headers.get("etag"), "\"a1b2c3\"");

  // A 304 outside /assets/ is left exactly as the host sent it.
  const plainNotModified = await call(worker, "/robots.txt", {
    env: host({
      "/robots.txt": { status: 304, headers: { "cache-control": "max-age=300" } },
    }),
  });
  eq("plain-text not-modified keeps its status", plainNotModified.response.status, 304);
  eq("plain-text not-modified keeps its cache header",
    plainNotModified.response.headers.get("cache-control"), "max-age=300");
}

// ---------------------------------------------------------------------------

globalThis.fetch = realFetch;
Date.now = realNow;

if (failures.length > 0) {
  console.error(`${failures.length} of ${checks} checks failed:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`all ${checks} checks passed`);
