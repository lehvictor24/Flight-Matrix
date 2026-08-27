# Flight Matrix

Full local implementation of `flight-fare-grid-technical-plan.md`, with every real
external dependency swapped for a local stand-in "for now": `mockFetcher.js` instead
of SerpApi, a JSON file instead of Postgres, and a plain Node `http` server instead
of a deployed API. The architecture (cache tiers, TTL, dedupe, budget cap, route
boundaries) matches the plan exactly — only the two literal external services are
mocked, so swapping either one in later (plan §11/§12) shouldn't require touching
the cache/dedupe/budget layers or the frontend.

## Running it

```
./run.sh
```

starts both the API server (`:8787`) and the Vite dev server, and installs
dependencies on first run. Or manually:

```
npm install
npm run server   # terminal 1 — the API (server/http.js)
npm run dev      # terminal 2 — the frontend (flight-fare-grid.jsx)
```

Vite proxies `/api/*` to the server (see `vite.config.js`), so the frontend just
calls `fetch("/api/...")` the way it would against a deployed backend.

Other scripts:

- `npm run build` / `npm run preview` — static production bundle
- `npm run demo` — `demo.js`, a Node-only pipeline check (no server, no browser)
- `npm run scheduler` — one-shot nightly diagonal refresh (`--loop` to repeat every 24h)
- `npm run alerter` — checks alerts against cached prices, logs to `server/data/alerts.log`
- `npm test` — the plan §11 test suite (TTL, dedupe, budget, integration), via Node's
  built-in test runner — zero extra dependencies

`flight-fare-grid-demo.html` is a separate, pre-bundled fallback with no server and
no `npm install` needed — it computes fares directly in the browser (not through the
cache/budget layers) and is useful only for a quick dependency-free preview.

## Architecture

Everything is Node built-ins only (`http`, `fs`, `path`, `node:test`) — no npm
packages beyond React/Vite for the frontend build.

```
flight-fare-grid.jsx (browser)
  │  fetch("/api/...")
  ▼
server/http.js            — plan §8 routes
  │
  ▼
server/pricingService.js  — maps routes onto calculations.js + cache keys
  │
  ├─ calculations.js      — pure matrix/options/itinerary math (Fetcher-agnostic)
  │
  ▼
server/cache.js           — getFare(): fresh/stale/missing + TTL (§3)
  ├─ server/dedupe.js     — in-flight request coalescing (§4)
  ├─ server/budget.js     — daily call cap, checked before every Fetcher call (§6)
  └─ server/storage.js    — JSON-file-backed fare_cache/trip_price_cache/api_usage/alerts (§2)
       │
       ▼
     mockFetcher.js       — randomized simulated fares, stands in for SerpApi (§5/§12)
```

`server/scheduler.js` (§7) and `server/alerter.js` (§9) are separate scripts that
also go through `cache.js`/`storage.js` — no code path bypasses the cache or budget
check, matching the plan's core guarantee.

### Routes (`server/http.js`, plan §8)

| Route | Cost | Notes |
|---|---|---|
| `GET /api/fare-grid` | cache-through | tier 1 — one lookup per grid cell |
| `GET /api/fare-options` | free, cache-only | whatever's already in `trip_price_cache` for this cell |
| `POST /api/fare-options/check` | cache-through | tier 2 — the only route allowed to price every permutation; rate-limited |
| `POST /api/fare-cell/refresh` | cache-through | manual refresh, bypasses TTL, still budget-gated |
| `POST /api/itinerary` | free | pure calculation, no Fetcher call |
| `GET /api/usage` | free | today's `api_usage` vs the daily cap |
| `GET`/`POST /api/alerts` | free | manage alert thresholds (§9) |

### Files

- **`mockFetcher.js`** — the only thing that would change to go live (plan §5/§12):
  swap it for a module with the same `fetchFare({ origin, destination, stopsOrder,
  dOff, rOff }) -> { total, legs }` signature, backed by a real SerpApi call. Reads
  `USE_LIVE_API` from the environment — if `"true"`, `fetchFare()` throws instead of
  returning mock data, so a stray live flag can't silently fall through to fake data.
- **`calculations.js`** — pure matrix/options/itinerary math. Takes an optional
  injectable `fetcher` param (defaults to `mockFetcher.fetchFare`) so
  `server/pricingService.js` can pass in the cached/budgeted version without this
  file knowing anything about caching.
- **`server/storage.js`** — local JSON-file persistence (`server/data/db.json`),
  standing in for the four Postgres tables in plan §2.
- **`server/cache.js`** — `getFare()`/`forceRefreshFare()`, the only entry points
  above it for turning a route+dates+order into a price.
- **`server/dedupe.js`**, **`server/budget.js`** — in-flight coalescing and the
  daily call cap (`API_DAILY_CAP` env var, default 200).
- **`server/pricingService.js`** — wires `calculations.js` to the cache layer;
  what `server/http.js`'s route handlers actually call.
- **`demo.js`** — runs the full pipeline once and prints real `api_usage` (persisted
  in `server/data/db.json`, so it accumulates across runs like a real table would)
  against the daily cap.

## Personal-scale test DB

Tests use a throwaway `DB_PATH` (via env var) so `npm test` never touches
`server/data/db.json` — see `tests/*.test.js`.

## Going live later (plan §11/§12)

Two swaps, nothing else should need to change:

1. Replace `mockFetcher.js` with a real SerpApi-backed Fetcher.
2. Replace `server/storage.js` with a Postgres client (same function signatures).
