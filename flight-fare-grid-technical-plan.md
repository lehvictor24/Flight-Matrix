# Flight Fare Grid — Technical Implementation Plan

This plan turns the working prototype (fake data, client-only React component) into a real
app backed by live fare data, a cost-controlled cache, and a small deployed service. It's
written as a build spec for Claude Code — each phase is a self-contained task with a clear
definition of done. Every phase below is designed so no component can call SerpApi without
passing through the cache and the budget check first.

---

## 0. What the prototype already proves out (don't re-litigate these)

- Configurable origin, destination, and 1–4 in-between stops
- Round trip vs. multi-city mode toggle
- ±5 day flexible date grid (11×11 depart/return matrix)
- In-between stops priced across every possible visiting order, cheapest shown
- Clicking a cell lists alternate options (city orders, or carrier variants for round trip)
- Full per-leg itinerary with dates, airline, and price breakdown
- Simulated cache freshness indicator + manual refresh per cell

The job now: replace the fake `computePriceForOrder` / `generateOptions` functions with
real fetched data, without losing this behavior, and without the cost model blowing up.

---

## 1. Key design decision: grid vs. detail pricing are NOT the same cost tier

The prototype computes every permutation's price for every one of the 121 grid cells,
because it's free (just math). Real API calls are not free, so the real system splits
into two cost tiers:

| Tier | When | What it does | Cost |
|---|---|---|---|
| **Grid estimate** | Rendering the 11×11 matrix | One fare lookup per cell, using the single stop order the user has arranged (not every permutation) | ~30–120 calls per route config, governed by the constrained-diagonal strategy in §4 |
| **Cell detail / options** | User clicks a cell and explicitly requests alternates | Full permutation search — one lookup per ordering — for that one date pair only | Up to `stops.length + 1` chained calls per ordering, fired only by explicit user action, cached thereafter |

The grid always shows the default-order price with a note that cheaper orderings may
exist. Finding them is deferred to an explicit, cached, on-demand action rather than run
automatically for every cell — this is the single biggest cost lever in the whole system.

---

## 2. Storage layer (build first — nothing else can start without it)

```sql
CREATE TABLE fare_cache (
  cache_key      TEXT PRIMARY KEY,       -- origin_stops_depart_return, single order
  origin         TEXT NOT NULL,
  destination    TEXT NOT NULL,
  stops          TEXT[],
  depart_date    DATE NOT NULL,
  return_date    DATE NOT NULL,
  price_total    INT NOT NULL,
  leg_prices     JSONB,
  raw_response   JSONB,
  fetched_at     TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL
);
CREATE INDEX idx_fare_lookup ON fare_cache (origin, destination, depart_date, return_date);
CREATE INDEX idx_fare_freshness ON fare_cache (fetched_at);

CREATE TABLE trip_price_cache (
  cache_key      TEXT PRIMARY KEY,       -- route + dates + specific stop order
  order_sequence TEXT[] NOT NULL,
  price_total    INT NOT NULL,
  leg_prices     JSONB,
  fetched_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE api_usage (
  day            DATE PRIMARY KEY,
  calls_made     INT NOT NULL DEFAULT 0,
  cost_estimate  NUMERIC(10,2) DEFAULT 0
);

CREATE TABLE alerts (
  id             SERIAL PRIMARY KEY,
  route_signature TEXT NOT NULL,
  threshold_price INT NOT NULL,
  active         BOOLEAN DEFAULT true,
  last_triggered TIMESTAMPTZ
);
```

Postgres is the single source of truth. No component talks to SerpApi directly except
the Fetcher (§5).

---

## 3. Cache-read wrapper — build before anything calls SerpApi

`get_fare(key)` is the only entry point components use to get a price. It never lets a
caller reach SerpApi directly.

- **Fresh** (within TTL) → return immediately, no API call
- **Stale** (past TTL) → return the stale value immediately, queue a background refresh
  (stale-while-revalidate — the user never blocks on SerpApi's response time)
- **Missing** → fetch synchronously through the Fetcher, write to cache, return

**TTL by volatility** — prices closer to departure move faster, so TTL is not flat:

| Days to departure | TTL |
|---|---|
| < 14 days | 6–12h |
| 14–60 days | 24h |
| > 60 days | 48h+ |

---

## 4. Dedupe layer

In-flight request tracking keyed by cache key. If two callers request the same key in
the same window (e.g. two grid cells or two users triggering the same lookup), only one
SerpApi call fires and both callers receive the shared result. This prevents a burst of
simultaneous cache misses — like a first-ever grid load — from firing redundant parallel
calls for the same data.

---

## 5. Fetcher (only component allowed to call SerpApi)

- All real API calls route through here — nothing else holds a SerpApi client
- Batches via SerpApi's date-grid endpoint where possible instead of one call per
  date/route combo
- On a cache miss burst (e.g. 30+ misses from a first load), the Fetcher queues and
  rate-limits (e.g. max 5 concurrent, small delay between) rather than firing all at once
- Increments `api_usage.calls_made` on every real call — this is the only writer to that
  counter, so it can't be bypassed by another code path

---

## 6. Budget guardrail

- Checked **before** any Fetcher call fires, not after
- Hard daily cap (e.g. 200 calls/day, sized to the SerpApi plan tier)
- Once hit: force cache-only mode app-wide — serve whatever's cached, show a
  "prices last refreshed X" banner, never error
- Manual per-cell refresh button is the one user-triggered path allowed to bypass TTL,
  but it still counts against and is blocked by the same daily cap

---

## 7. Scheduler

- Nightly bulk refresh, constrained to the relevant diagonal date combos (fixed trip
  length ± offset) rather than the full depart×return cross-product, to keep volume low
- Runs through the same `get_fare()` wrapper as everything else — there is no separate
  scheduler code path that could bypass the cache or the budget check

---

## 8. API routes

**`GET /api/fare-grid`** — cache-only, always free. Reads `fare_cache` for the current
route config and returns the grid. Never calls SerpApi.

**`GET /api/fare-options`** — cache-only, always free.
```
?origin=rdu&destination=rdu&stops=nrt,tpe,sin&departOffset=0&returnOffset=0
```
Reads `trip_price_cache` for every permutation already priced for this exact date pair
and returns whatever exists — nothing, one entry, or the full set. The frontend calls
this the instant a cell is selected, so previously-checked alternates display by default
with zero cost and zero latency.

**`POST /api/fare-options/check`** — the only route allowed to spend real API calls for
permutation search. Fired solely by the "Check other orders" button. Runs the full
permutation search through the Fetcher, writes every result to `trip_price_cache`, and
returns the sorted list. Cached per exact (route, dates, order) key afterward — the
first check pays the cost once; every subsequent view of that date pair, by anyone, is
free until it goes stale.

This means the frontend behavior is: cached alternates show automatically wherever
`trip_price_cache` already has an entry; the button only appears (and only spends
quota) when nothing is cached yet.

---

## 9. Alerter

Separate scheduled job (daily) reading `alerts` against current cached prices in
`fare_cache`. Sends a notification (email/Slack) if a threshold is crossed. Runs
entirely off cached data — zero additional API cost.

---

## 10. Frontend

- Grid reads from `GET /api/fare-grid` only
- Cell click reads from `GET /api/fare-options` (free) and renders whatever's cached
- "Check other orders" button appears only when the cache-only read comes back empty,
  and is the sole trigger for `POST /api/fare-options/check`
- "Updated Xh ago" freshness indicator per cell, sourced from `fetched_at`
- Manual per-cell refresh button, the only other path allowed to bypass TTL

---

## Cost math

Without caching: every grid view = up to 121 combos × repeated views/day. With the
tiered model above (single-order grid pricing, 24h+ TTL, nightly constrained-diagonal
refresh, permutation search gated behind an explicit cached button): roughly 30–50 calls
once per day for the grid, plus a one-time cost per date pair whenever someone first
checks alternates — comfortably inside a $25/mo SerpApi Starter plan for personal-scale
use.

## 11. Deployment & ops

**Hosting**
- API + scheduler: a small always-on host works better than pure serverless here, since
  the scheduler needs to run a nightly job and the dedupe layer (§4) needs in-process
  state — Fly.io or Railway are a good fit for personal scale; AWS Lambda + EventBridge
  works too if the dedupe layer is moved to a shared store (e.g. a Redis lock) instead of
  in-memory
- Postgres: managed hosting (Neon, Supabase, or RDS) rather than self-hosting — backups
  and connection pooling come for free

**Secrets**
- SerpApi key and DB credentials go in environment variables / the host's secrets
  manager, never committed to the repo or hardcoded into the Fetcher
- `.env.example` checked into the repo with placeholder keys, real `.env` gitignored

**Auth on the cost-triggering route**
- `GET /api/fare-grid` and `GET /api/fare-options` can stay open (cache-only, free)
- `POST /api/fare-options/check` is the one route that spends money — this needs at
  minimum a per-IP or per-session rate limit (e.g. N checks/hour) even for a personal
  tool, since it's the only endpoint an outside caller could use to burn quota directly
- If this ever becomes multi-user, add real auth (API key or session) on the check route
  specifically, even if the rest of the app stays open

**Error handling**
- Fetcher wraps every SerpApi call in retry-with-backoff (e.g. 3 attempts, exponential)
  for transient failures, and a circuit breaker that trips to cache-only mode if SerpApi
  is erroring repeatedly — same fallback UI as hitting the budget cap
- Failed fetches log the error and route/date key rather than silently dropping, so the
  scheduler's nightly run can be diffed against what it intended to refresh

**Monitoring**
- Log (or emit to a simple dashboard): daily `calls_made` vs. cap, cache hit rate,
  scheduler run success/failure, SerpApi error rate
- A daily cache-hit-rate metric is the fastest signal that the cache-first design is
  actually working in production, not just on paper

**Testing (prioritize these — they're the cost-control logic)**
- TTL logic: unit tests asserting fresh/stale/missing classification at each
  days-to-departure bucket from §3
- Dedupe layer: test that concurrent requests for the same key produce exactly one
  Fetcher call
- Budget guardrail: test that the cap blocks a Fetcher call before it fires, and that
  cache-only mode engages correctly once the cap is hit
- Integration test for the full `get_fare()` path against a mocked SerpApi response

**Legal**
- Quick check of SerpApi's terms of service on caching/redistributing results before
  this serves more than one user

---

## 12. Personal-scale environments & accuracy checks

Sized for one user, not a team — skip anything that smells like enterprise process.

**Environments (minimal split)**
- One prod Postgres + prod SerpApi key. A second, free-tier Postgres (or just a
  separate schema in the same instance) for dev, seeded with a handful of fixture rows
  instead of live data — no need for a full staging tier at this scale
- Dev points at a **mocked** Fetcher (fixed fake responses) by default, so local
  development never touches the real SerpApi key or counts against the daily cap.
  A `USE_LIVE_API=true` env flag opts into real calls only when explicitly testing the
  Fetcher itself
- Same budget guardrail code path runs in dev, just against a tiny cap (e.g. 5/day) so a
  bug can't quietly rack up real spend even if someone forgets the mock flag

**Data lifecycle**
- Weekly cron: delete `fare_cache` / `trip_price_cache` rows older than 90 days —
  one query, no need for a formal retention tool at this scale
- Rely on the managed Postgres host's automatic backups (Neon/Supabase/RDS all include
  this) rather than building custom backup tooling

**Rollback**
- "Redeploy the previous git commit" is sufficient — write it down as the one-line
  runbook so it's not improvised under pressure, but nothing fancier is needed

**All-in cost ceiling**
- SerpApi Starter (~$25/mo, per §1 cost math) + smallest managed Postgres tier
  (often free or ~$5–10/mo) + smallest compute tier on Fly.io/Railway (~$5/mo) →
  realistic ceiling of ~$35–40/mo total

**Tests to confirm accuracy** (beyond the cost-control tests in §11 — these verify the
*data itself* is trustworthy, not just that the caching logic behaves)

- **Live spot-check test**: a manual/on-demand script that takes 3–5 cached fare
  entries, re-fetches them live from SerpApi, and diffs the price. Run this after any
  change to the Fetcher's parsing logic, and periodically (e.g. monthly) to catch silent
  drift in SerpApi's response shape
- **Staleness assertion**: test that a cache row past its TTL is actually flagged stale
  and never silently served as fresh — this is the one bug that would make the whole
  app quietly show wrong prices while looking fine
- **Permutation math check**: for a known 3-stop route, assert the chained-call pricing
  logic (§8, `stops.length + 1` calls per ordering) sums leg prices correctly against a
  hand-computed expected total — this logic is easy to get subtly wrong
- **Grid vs. detail consistency**: test that the grid's single-order price for a cell
  matches the corresponding entry in `trip_price_cache` once that order's been checked —
  they read from different tables and should never disagree
- **Timezone/date-boundary test**: fares near midnight local time are a classic
  off-by-one-day bug source — test that a depart date stored and displayed matches what
  was actually queried, across at least one non-UTC timezone

---

## Build order

1. Storage layer (§2)
2. Cache-read wrapper (§3)
3. Dedupe layer (§4)
4. Budget guardrail (§6) — before the Fetcher is wired to anything
5. Fetcher (§5), with retry/backoff, circuit breaker, and mock mode from §11–§12
6. API routes (§8), with rate limiting on the check route from §11
7. Scheduler (§7)
8. Alerter (§9)
9. Frontend (§10)
10. Deployment: hosting, secrets, monitoring, dev/prod split (§11–§12)
11. Accuracy test suite (§12) — run before flipping the scheduler on in prod

Guardrails exist before the Fetcher is connected to any caller, so it's structurally
impossible for a new component to accidentally hit SerpApi without passing through the
cache and the cost check first.
