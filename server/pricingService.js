// server/pricingService.js
//
// Orchestrates calculations.js against the cache/dedupe/budget layers instead of
// letting it hit mockFetcher directly. This is what server/http.js's route
// handlers call. Nothing here ever imports mockFetcher.js itself — that's
// cache.js's job — so this stays the one place that knows how a route config
// maps onto cache keys.
//
// departCenter/returnCenter (the configurable date range — plan's "your dates")
// arrive here as "YYYY-MM-DD" strings from the frontend's date pickers and
// default to calculations.js's DEPART_CENTER/RETURN_CENTER when omitted, so
// demo.js and server/scheduler.js don't need to know about them at all.

import {
  buildMatrix,
  generateOptions,
  buildItineraryForOrder,
  CITIES,
  DEPART_CENTER,
  RETURN_CENTER,
} from "../calculations.js";
import { getFare, forceRefreshFare } from "./cache.js";
import { getAllTripPriceCacheRowsForRoute } from "./storage.js";

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
/** Parses "YYYY-MM-DD" as a local-midnight Date, matching how the module
 *  defaults are constructed (new Date(y, m, d)) — avoids the off-by-one-day
 *  bug that `new Date(isoString)` (UTC parse) can introduce depending on the
 *  server's timezone (plan §12's "timezone/date-boundary" test exists for
 *  exactly this class of bug). */
function parseLocalDate(isoStr) {
  const [y, m, d] = isoStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function resolveCenter(isoStrOrUndefined, fallback) {
  return isoStrOrUndefined ? parseLocalDate(isoStrOrUndefined) : fallback;
}

function cacheKeyFor(origin, destination, stopsOrder, dOff, rOff, departCenter, returnCenter) {
  const departDate = isoDate(addDays(departCenter, dOff));
  const returnDate = isoDate(addDays(returnCenter, rOff));
  return { key: `${origin}|${destination}|${stopsOrder.join(",")}|${departDate}|${returnDate}`, departDate, returnDate };
}

function makeCachedFetcher(table, departCenter, returnCenter) {
  return async function cachedFetch({ origin, destination, stopsOrder, dOff, rOff }) {
    const { key, departDate, returnDate } = cacheKeyFor(origin, destination, stopsOrder, dOff, rOff, departCenter, returnCenter);
    const { row } = await getFare({ table, key, origin, destination, stopsOrder, dOff, rOff, departDate, returnDate });
    if (!row) {
      const err = new Error("Over daily API budget and nothing cached for this cell yet.");
      err.code = "OVER_BUDGET";
      throw err;
    }
    return { total: row.total, legs: row.legs };
  };
}

/** GET /api/fare-grid — tier 1, one cache-through fetch per cell (plan §3). */
export async function getGrid({ stops, origin, destination, departCenter, returnCenter }) {
  const dc = resolveCenter(departCenter, DEPART_CENTER);
  const rc = resolveCenter(returnCenter, RETURN_CENTER);
  return buildMatrix(stops, origin, destination, undefined, makeCachedFetcher("fareCache", dc, rc));
}

/**
 * GET /api/fare-options — cache-only, always free (plan §8). Returns whatever
 * permutations have already been priced for this exact route + date pair,
 * which is nothing until someone has called checkOptions() for it at least once.
 */
export function getCheckedOptions({ origin, destination, stops, dOff, rOff, departCenter, returnCenter }) {
  const dc = resolveCenter(departCenter, DEPART_CENTER);
  const rc = resolveCenter(returnCenter, RETURN_CENTER);
  const { departDate, returnDate } = cacheKeyFor(origin, destination, stops, dOff, rOff, dc, rc);
  const rows = getAllTripPriceCacheRowsForRoute(`${origin}|${destination}|`).filter(
    (row) =>
      row.departDate === departDate &&
      row.returnDate === returnDate &&
      row.stops.length === stops.length &&
      stops.every((s) => row.stops.includes(s))
  );
  const priced = rows
    .map((row) => ({
      order: row.orderSequence,
      total: row.total,
      legs: row.legs,
      label: row.orderSequence.map((s) => CITIES[s].city).join(" → "),
    }))
    .sort((a, b) => a.total - b.total);
  return priced.map((p, i) => ({ ...p, isCheapest: i === 0 }));
}

/** POST /api/fare-options/check — tier 2, the only route allowed to spend budget on permutations. */
export async function checkOptions({ stops, origin, destination, dOff, rOff, departCenter, returnCenter }) {
  const dc = resolveCenter(departCenter, DEPART_CENTER);
  const rc = resolveCenter(returnCenter, RETURN_CENTER);
  return generateOptions(stops, origin, destination, dOff, rOff, makeCachedFetcher("tripPriceCache", dc, rc));
}

/** POST /api/fare-cell/refresh — bypasses TTL, still gated by the budget cap. */
export async function refreshCell({ stops, origin, destination, dOff, rOff, departCenter, returnCenter }) {
  const dc = resolveCenter(departCenter, DEPART_CENTER);
  const rc = resolveCenter(returnCenter, RETURN_CENTER);
  const { key, departDate, returnDate } = cacheKeyFor(origin, destination, stops, dOff, rOff, dc, rc);
  const { row } = await forceRefreshFare({
    table: "fareCache",
    key,
    origin,
    destination,
    stopsOrder: stops,
    dOff,
    rOff,
    departDate,
    returnDate,
  });
  if (!row) {
    const err = new Error("Over daily API budget — can't force-refresh right now.");
    err.code = "OVER_BUDGET";
    throw err;
  }
  return { total: row.total, legs: row.legs, order: stops };
}

/** Pure calculation, no Fetcher involved — safe to call from anywhere, any time. */
export function getItinerary({ stops, origin, destination, dOff, rOff, legs, departCenter, returnCenter }) {
  const dc = resolveCenter(departCenter, DEPART_CENTER);
  const rc = resolveCenter(returnCenter, RETURN_CENTER);
  return buildItineraryForOrder(dOff, rOff, stops, origin, destination, legs, dc, rc);
}
