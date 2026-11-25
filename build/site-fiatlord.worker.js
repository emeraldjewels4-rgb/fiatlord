// Static host for the FiatLord shell, plus the prices route and a build-identity
// answer.
//
// The dashboard polls GET /api/coinspot/prices every 15 s (60 s while hidden)
// and expects {ok: true, prices: {<code>: {last, bid, ask}}, missing: [...]}.
// That route is served from CoinSpot's public ticker here, not from the
// fiatgod.x10.mx PHP host (unreachable) and not from the SPA fallback.
//
// If the upstream is down, the last good snapshot is replayed with every entry
// marked {source: "carried", carriedAt: <ms>}, which is how the dashboard tells
// stale-but-real prices from nothing at all. That snapshot is kept in module
// scope for a warm isolate and in the site's D1 database for a cold one, though
// only a recent row is honoured there: an isolate revived after days offline
// must not present last week's prices as this minute's. With neither, the route
// answers 502 and the page falls back to its simulated feed. The database is
// written after the answer, never before it: a quote must not wait on a table
// creation or a write it does not need. That leaves the write's outcome out of
// sight, so every prices answer reports the last mirror attempt in a `snapshot`
// field (`idle`/`pending`/`written`/`failed`/`unbound`, with the failure reason),
// which is how a write that never lands is noticed from outside.
// Every other /api/* path is deliberately unimplemented on this static host:
// /api/coinspot/balance, /sell and /deposit need a server that can sign CoinSpot
// requests, which this Worker cannot do. They answer JSON 501 rather than falling
// through to the SPA shell, because the dashboard parses every /api/ response as
// JSON and would otherwise report "this host answered without JSON" instead of
// a plain reason. The default cache binding is not permitted on this host; the
// snapshot is kept in module scope and mirrored into D1 instead.
// /api/version is the one other answer: it reports which worker and which page
// this host is running, so a deployment can be compared with a clone in one call.

let lastSnapshot = null; // { prices, fetchedAt }

// The last good snapshot is also written to the site's D1 database, because
// module scope is per isolate: a fresh one starts empty, and on a cold start
// with CoinSpot unreachable that used to mean nothing but the simulated feed.
// The database is a fallback, never the primary: every call to it is best-effort
// and wrapped, so a missing or failing binding costs the carry-over and nothing
// else. Module scope stays in front of it so a warm isolate never pays a query,
// and the mirror itself is scheduled off the request path (see mirror()). A
// stored row is only honoured while it is recent (STORED_MAX_AGE_MS): a revived
// isolate must not present last week's prices as this minute's.
const SNAPSHOT_CREATE =
  "CREATE TABLE IF NOT EXISTS price_snapshot " +
  "(id INTEGER PRIMARY KEY CHECK (id = 1), fetched_at INTEGER NOT NULL, prices TEXT NOT NULL)";
const SNAPSHOT_READ = "SELECT fetched_at, prices FROM price_snapshot WHERE id = 1";
// One row, replaced in place. INSERT OR REPLACE is the oldest spelling of this
// and needs nothing from the engine beyond a primary key.
const SNAPSHOT_WRITE =
  "INSERT OR REPLACE INTO price_snapshot (id, fetched_at, prices) VALUES (1, ?, ?)";

// Created once per isolate, by the first mirror, and only there: the read path
// must not pay for a table creation it is about to query anyway. Reset on
// failure so a later mirror can try again rather than inheriting a rejected
// promise.
let schemaReady = null;
function schema(db) {
  if (!schemaReady) {
    schemaReady = db.prepare(SNAPSHOT_CREATE).run().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

// A stored row can be any age -- isolates die, the upstream can be unreachable
// for days, and the row simply stays where it was. Carrying a week-old price is
// worse than showing none: the page presents a carried price as real, so a
// revived isolate that reads back something ancient would quote stale numbers as
// if they were current. Anything older than this is treated as absent.
const STORED_MAX_AGE_MS = 5 * 60_000;

// Writing on every poll would spend the database's monthly write allowance for
// nothing: the row only has to be recent enough to carry, not as new as the
// answer. A row younger than this is left alone, so a dashboard polling every
// 15 s costs about one write a minute instead of four, and the carry window is
// still five minutes. The threshold is the row's age, not this isolate's, so a
// fresh row written elsewhere counts too.
const MIRROR_MIN_INTERVAL_MS = 60_000;

// The read is the one database call that has to happen before an answer: on a
// cold start with the upstream down it is the only thing that can. It does not
// create the table, because a missing table means nothing was ever written, and
// the failure costs a caught exception rather than a schema round trip. An old
// row is not deleted, only ignored: the mirror owns the row and the next good
// fetch replaces it.
// One read of the row, without the age gate. The probe needs the row's age even
// when it is too old to carry, because "expired and ignored" and "never written"
// are different states that used to answer identically. Everything else goes
// through readSnapshot, which is this plus the gate.
async function storedRow(db) {
  if (!db) return { state: "unbound" };
  try {
    const row = await db.prepare(SNAPSHOT_READ).first();
    if (!row) return { state: "empty" };
    const prices = JSON.parse(row.prices);
    const fetchedAt = Number(row.fetched_at);
    if (!prices || typeof prices !== "object" || !Number.isFinite(fetchedAt)) {
      return { state: "unreadable" };
    }
    return { state: "present", snapshot: { prices, fetchedAt }, ageMs: Date.now() - fetchedAt };
  } catch (error) {
    return { state: "failed", error: message(error) };
  }
}

async function readSnapshot(db) {
  const row = await storedRow(db);
  if (row.state !== "present" || row.ageMs > STORED_MAX_AGE_MS) return null;
  return row.snapshot;
}

function message(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 160);
}

// Returns what happened instead of swallowing it: the outcome is what the
// prices answer reports, so a write that never lands is visible from outside
// rather than only in a missing carry-over weeks later.
async function writeSnapshot(db, snapshot) {
  if (!db) return { ok: false, error: "no DB binding" };
  try {
    await schema(db);
    const result = await db
      .prepare(SNAPSHOT_WRITE)
      .bind(snapshot.fetchedAt, JSON.stringify(snapshot.prices))
      .run();
    const changes = Number(result?.meta?.changes ?? result?.changes);
    return { ok: true, changes: Number.isFinite(changes) ? changes : null };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// Read-after-write. A resolved run() only says D1 accepted the statement; the
// row is what the next cold isolate depends on, so the mirror reads it back and
// compares the timestamp. A row at least as new as this write counts: another
// isolate may have replaced it with a fresher price, which is just as good.
async function confirmSnapshot(db, fetchedAt) {
  try {
    const row = await db.prepare(SNAPSHOT_READ).first();
    if (!row) return { ok: false, error: "no row after write" };
    const stored = Number(row.fetched_at);
    if (!Number.isFinite(stored)) return { ok: false, error: "row has no timestamp" };
    if (stored < fetchedAt) return { ok: false, error: "row is older than the write" };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// The last mirror attempt made by this isolate, reported in every prices answer.
// The write itself runs after the response, so an answer describes the attempt
// that finished before it: "pending" means one is in flight, "written" means the
// row was read back, "fresh" means the row was recent enough to leave alone,
// "failed" carries the reason, and "unbound" means this host was given no
// database at all.
let mirrorState = { state: "idle" };

// The write and its table creation are background work, not part of the answer.
// Awaited, they put D1 -- a round trip, plus a schema creation on the first
// refresh of every isolate -- between the upstream ticker and the page's quotes,
// so a slow or failing database would be felt as a slow price. Scheduled, the
// quote is answered from the values already fetched and the mirror catches up on
// its own. waitUntil is what keeps the isolate alive for it after the response
// has gone out; without an execution context (a plain fetch in a test) the
// promise is simply left to run. Neither function rejects, so neither form can
// raise an unhandled rejection.
function mirror(env, ctx, snapshot) {
  const db = env?.DB;
  if (!db) {
    mirrorState = { state: "unbound", fetchedAt: snapshot.fetchedAt };
    return;
  }
  mirrorState = { state: "pending", fetchedAt: snapshot.fetchedAt };
  const work = (async () => {
    // Skipped writes are reported rather than hidden: "fresh" says the row was
    // already recent enough, which is a different outcome from "written" and
    // from a failure, and it is what keeps a polling page off the write quota.
    const row = await storedRow(db);
    if (row.state === "present" && row.ageMs >= 0 && row.ageMs < MIRROR_MIN_INTERVAL_MS) {
      mirrorState = {
        state: "fresh",
        fetchedAt: snapshot.fetchedAt,
        storedAt: row.snapshot.fetchedAt,
        ageMs: row.ageMs,
      };
      return;
    }
    const written = await writeSnapshot(db, snapshot);
    if (!written.ok) {
      mirrorState = { state: "failed", fetchedAt: snapshot.fetchedAt, error: written.error };
      return;
    }
    const confirmed = await confirmSnapshot(db, snapshot.fetchedAt);
    mirrorState = confirmed.ok
      ? {
          state: "written",
          fetchedAt: snapshot.fetchedAt,
          changes: written.changes,
          at: Date.now(),
        }
      : {
          state: "failed",
          fetchedAt: snapshot.fetchedAt,
          changes: written.changes,
          error: confirmed.error,
        };
  })();
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(work);
}

const UPSTREAMS = [
  "https://www.coinspot.com.au/pubapi/v2/latest",
  "https://www.coinspot.com.au/pubapi/latest",
];
const FRESH_MS = 10_000;
const UPSTREAM_TIMEOUT_MS = 6_000;

const PRICES_PATH = "/api/coinspot/prices";
const API_PREFIX = "/api/";
// The dashboard puts `error` straight in front of the user, so it has to read as
// a sentence: "not implemented" looked like a bug report rather than an answer.
const UNIMPLEMENTED_ERROR = "CoinSpot signing is not available on this host";
const UNIMPLEMENTED_REASON =
  "CoinSpot signing needs a server; this is a static host and can only read public prices.";

// The bundles carry their content hash in the filename, so a given URL never
// changes and the browser may keep it for a year. The shell must be revalidated
// instead: it is the only file that names the current bundle, so a cached copy
// would keep serving the previous build to anyone who has visited before.
// HTML is checked before the path: an unknown /assets/ URL answers with the SPA
// shell, and marking that immutable would pin a stale shell under an asset URL.
const ASSET_PREFIX = "/assets/";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHELL_CACHE = "no-cache";

// Which build this is. Nothing else in the worker can say: a deployment uploads
// this file verbatim, so there is no build step to inject a commit, and a host
// that cannot name the code it runs cannot be compared with a clone. The value
// is sha256 of this source with the value zeroed out, restamped by
// build/worker-id.mjs and asserted by the harness -- a stale stamp fails the
// staging check rather than shipping.
const WORKER_ID = "cc9c6315767d";
const VERSION_PATH = "/api/version";

function toNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// CoinSpot returns {status:"ok", prices:{btc:{bid,ask,last},...}} with string
// numbers; both the v1 and v2 tickers use that shape.
function normalise(upstream) {
  if (!upstream || upstream.status !== "ok" || !upstream.prices) return null;
  const prices = {};
  for (const [code, quote] of Object.entries(upstream.prices)) {
    const last = toNumber(quote?.last);
    const bid = toNumber(quote?.bid);
    const ask = toNumber(quote?.ask);
    if (last === null && (bid === null || ask === null)) continue;
    prices[code.toLowerCase()] = {
      last: last ?? (bid + ask) / 2,
      bid: bid ?? last,
      ask: ask ?? last,
    };
  }
  return Object.keys(prices).length > 0 ? prices : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function fetchUpstream() {
  for (const url of UPSTREAMS) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const prices = normalise(await res.json());
      if (prices) return prices;
    } catch {
      // try the next ticker; a dead upstream must not throw past this point
    }
  }
  return null;
}

// One shape for both sources of a carried answer: the isolate's own snapshot and
// the one it read back from storage are the same thing to the page.
function carriedBody(snapshot) {
  const prices = {};
  for (const [code, quote] of Object.entries(snapshot.prices)) {
    prices[code] = { ...quote, source: "carried", carriedAt: snapshot.fetchedAt };
  }
  return {
    ok: true,
    prices,
    missing: [],
    carriedAt: snapshot.fetchedAt,
    snapshot: mirrorState,
  };
}

function carried(snapshot) {
  return json(carriedBody(snapshot));
}

// The cold-start read is the one path that cannot be observed from outside by
// asking normally: a host that already holds a price never reads the row, so a
// 200 says nothing about storage. `?diag=stored` forces exactly the steps a
// freshly booted isolate takes -- read the row, carry it -- and nothing else:
// no upstream fetch, no module snapshot, no write. `isolate` reports whether
// this host already held a price, so a reader can tell a forced read on a warm
// host from the same read on a cold one. `stored` reports the row itself even
// when it is too old to carry, so an expired row is visibly ignored rather than
// indistinguishable from an empty table.
const DIAG_STORED = "stored";
// The same read, made reproducible. The probe cannot otherwise say what a fresh
// isolate would answer: a host reports `warm` whenever a live fetch has run in
// it, and whether the next request lands on such a host is routing luck, not
// something a caller can ask for. `?diag=cold` lets go of this isolate's module
// snapshot and then runs exactly the cold-start branch -- read the row, carry
// it -- so one request always takes the path a newly booted isolate takes.
// Nothing is deleted from storage and no write happens: only memory is dropped,
// and the next ordinary request refetches as it would on a host that had never
// answered, so the prices path is unchanged.
const DIAG_COLD = "cold";
const DIAG_VALUES = [DIAG_STORED, DIAG_COLD];

async function storedProbe(env, diag = DIAG_STORED) {
  const cleared = diag === DIAG_COLD;
  if (cleared) lastSnapshot = null;
  const isolate = lastSnapshot ? "warm" : "cold";
  const row = await storedRow(env?.DB);
  // Always reported, used or not: `present` with an age past the window is the
  // expired-and-ignored case, which a bare 502 could not tell from an empty table.
  const stored = {
    present: row.state === "present",
    ageMs: row.state === "present" ? row.ageMs : null,
  };
  if (row.state !== "present" || row.ageMs > STORED_MAX_AGE_MS) {
    const error =
      row.state === "unbound" ? "no DB binding"
        : row.state === "failed" ? `stored row read failed: ${row.error}`
        : row.state === "unreadable" ? "stored row is unreadable"
        : row.state === "empty" ? "no stored row"
        : "stored row is older than 5 minutes";
    return json(
      {
        ok: false,
        diag,
        source: "none",
        isolate,
        cleared,
        error,
        stored,
        snapshot: mirrorState,
      },
      502,
    );
  }
  return json({
    diag,
    source: "stored",
    isolate,
    cleared,
    ageMs: row.ageMs,
    stored,
    ...carriedBody(row.snapshot),
  });
}

// The page's identity, for the other half of the same question: this isolates
// whether the code is current, not whether the assets are. The shell names the
// bundles by content hash, so a rebuilt staged tree changes these bytes even
// when nothing here does. Read once per isolate: the route is a diagnostic, and
// the prices path must never wait on it.
let pageIdentity;
async function pageId(env) {
  if (pageIdentity !== undefined) return pageIdentity;
  pageIdentity = null;
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.invalid/index.html"));
    if (!res.ok) return pageIdentity;
    const digest = await crypto.subtle.digest("SHA-256", await res.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    pageIdentity = hex.slice(0, 12);
  } catch {
    pageIdentity = null;
  }
  return pageIdentity;
}

// `?diag=stored` answers what the prices came from; this answers what is
// serving them. They are separate failures: a host can run current code over an
// old page, and the one curl that compares a deployment with a clone needs both.
async function versionRoute(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  return json({ ok: true, worker: WORKER_ID, assets: await pageId(env) });
}

async function pricesRoute(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  // Only the documented values are accepted: a mistyped flag must not quietly
  // turn into an ordinary live answer that looks like the probe succeeded.
  const diag = new URL(request.url).searchParams.get("diag");
  if (diag !== null) {
    if (!DIAG_VALUES.includes(diag)) {
      return json(
        { ok: false, error: "unknown diag", accepted: DIAG_VALUES },
        400,
      );
    }
    return storedProbe(env, diag);
  }

  const age = lastSnapshot ? Date.now() - lastSnapshot.fetchedAt : Infinity;
  if (lastSnapshot && age >= 0 && age <= FRESH_MS) {
    return json({
      ok: true,
      prices: lastSnapshot.prices,
      missing: [],
      fetchedAt: lastSnapshot.fetchedAt,
      snapshot: mirrorState,
    });
  }

  const prices = await fetchUpstream();
  if (prices) {
    lastSnapshot = { prices, fetchedAt: Date.now() };
    mirror(env, ctx, lastSnapshot);
    return json({
      ok: true,
      prices,
      missing: [],
      fetchedAt: lastSnapshot.fetchedAt,
      snapshot: mirrorState,
    });
  }

  if (lastSnapshot) return carried(lastSnapshot);

  // No snapshot in this isolate: a cold start. The last good answer may still be
  // in storage, and a carried price from a few minutes ago is worth more to the
  // page than the simulated feed.
  const stored = await readSnapshot(env?.DB);
  if (stored) {
    lastSnapshot = stored;
    return carried(stored);
  }

  return json({ ok: false, error: "price feed unavailable", snapshot: mirrorState }, 502);
}

// A 200 and a 304 are both rewritten; redirects and error pages are not, since
// they must keep whatever caching the asset server already gave them.
//
// The 304 matters as much as the 200: a not-modified answer replaces the headers
// the browser has stored for that URL, and the host answers a conditional
// request for an asset with `public, max-age=0, must-revalidate`. Left alone,
// that downgrade erases the year that the first 200 granted, and every later
// visit -- and every reload of the dashboard -- goes back to revalidating a
// 974 kB bundle instead of using the copy already on disk.
function withCacheHeaders(response, path) {
  if (response.status !== 200 && response.status !== 304) return response;
  const headers = new Headers(response.headers);
  const type = (headers.get("content-type") || "").toLowerCase();
  const asset = path.startsWith(ASSET_PREFIX);
  if (response.status === 304) {
    // Only the asset lifetime is restated here; anything else keeps the host's
    // own revalidation answer rather than being relabelled.
    if (!asset) return response;
    headers.set("cache-control", IMMUTABLE_CACHE);
  } else if (type.includes("text/html")) {
    headers.set("cache-control", SHELL_CACHE);
  } else if (asset) {
    headers.set("cache-control", IMMUTABLE_CACHE);
  } else {
    return response;
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    // Matched case-insensitively: the dashboard's own calls are lower case, but
    // /API/coinspot/sell would otherwise fall past both branches and be answered
    // with the shell and a 200, which is the exact failure the branches exist to
    // prevent. Anything spelled as an /api path gets an /api answer.
    const path = pathname.toLowerCase();
    if (path === VERSION_PATH || path === `${VERSION_PATH}/`) {
      try {
        return await versionRoute(request, env);
      } catch {
        return json({ ok: false, error: "internal error" }, 500);
      }
    }
    if (path === PRICES_PATH || path === `${PRICES_PATH}/`) {
      try {
        return await pricesRoute(request, env, ctx);
      } catch {
        return json({ ok: false, error: "internal error" }, 500);
      }
    }
    if (path === "/api" || path.startsWith(API_PREFIX)) {
      return json(
        { ok: false, error: UNIMPLEMENTED_ERROR, reason: UNIMPLEMENTED_REASON },
        501,
      );
    }
    return withCacheHeaders(await env.ASSETS.fetch(request), path);
  },
};
