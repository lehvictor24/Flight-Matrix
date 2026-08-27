# Flight Matrix — Mock Fetcher & Calculation Layer

Backend pieces for the flight fare grid app (see `flight-fare-grid-technical-plan.md`
for the full architecture). This package replaces the frontend prototype's synthetic
math with a real calculation layer driven by a Fetcher interface — currently a mock,
swappable for a live SerpApi Fetcher later without touching anything else.

## Files

- **`mockFetcher.js`** — placeholder for the real SerpApi Fetcher (plan §5). Generates
  randomized-but-bounded fare data per stop order + date pair, and tracks a call
  counter standing in for the `api_usage` table (plan §2/§6). Reads `USE_LIVE_API`
  from the environment — if set to `"true"`, `fetchFare()` throws instead of
  returning mock data, so a stray live flag can't silently fall through to fake
  numbers in production.

- **`calculations.js`** — the real matrix/options/itinerary logic, same output shapes
  the React prototype (`flight-fare-grid.jsx`) already expects:
  - `buildMatrix(stops, origin, destination)` — **tier 1**: one Fetcher call per grid
    cell, using the single stop order as arranged. This is the only pricing that
    should ever run automatically for a whole grid.
  - `generateOptions(stops, origin, destination, dOff, rOff)` — **tier 2**: one
    Fetcher call per possible stop ordering. Expensive — only call this from an
    explicit user action ("check other orders"), never automatically per cell.
  - `buildItineraryForOrder(...)` — pure calculation, no Fetcher call, builds the
    leg-by-leg dates/airlines/prices for a chosen ordering.

- **`demo.js`** — runs the full pipeline (`node demo.js`) and prints simulated API
  call usage against the plan's 200/day cap, so the cost shape is visible before
  anything touches a real key.

## Swapping in the real Fetcher later

Replace `mockFetcher.js` with a module exporting the same `fetchFare()` signature,
backed by an actual SerpApi call plus the Postgres cache-read wrapper from plan §3.
`calculations.js` and the frontend don't need to change — they only know about the
`fetchFare({ origin, destination, stopsOrder, dOff, rOff }) -> { total, legs }`
contract, not where the numbers come from.

## Next steps (per the technical plan)

1. Wrap `buildMatrix` / `generateOptions` behind the `GET /api/fare-grid` and
   `POST /api/fare-options/check` routes (plan §8) — the frontend should call these,
   not import `calculations.js` directly, since that's where the real API key will
   eventually live.
2. Add the Postgres cache-read wrapper (plan §3) in front of `fetchFare()` so repeat
   requests for the same cache key don't re-fetch within the TTL.
3. Add the dedupe layer (plan §4) and budget guardrail (plan §6) before wiring a
   live Fetcher in.
