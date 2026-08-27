// server/pricingService.js
//
// Orchestrates calculations.js against the cache/dedupe/budget layers instead of
// letting it hit mockFetcher directly. This is what server/http.js's route
// handlers call. Nothing here ever imports mockFetcher.js itself — that's
// cache.js's job — so this stays the one place that knows how a route config
// maps onto cache keys.

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

function cacheKeyFor(origin, destination, stopsOrder, dOff, rOff) {
  const departDate = isoDate(addDays(DEPART_CENTER, dOff));
  const returnDate = isoDate(addDays(RETURN_CENTER, rOff));
  return { key: `${origin}|${destination}|${stopsOrder.join(",")}|${departDate}|${returnDate}`, departDate, returnDate };
}

function makeCachedFetcher(table) {
  return async function cachedFetch({ origin, destination, stopsOrder, dOff, rOff }) {
    const { key, departDate, returnDate } = cacheKeyFor(origin, destination, stopsOrder, dOff, rOff);
    const { row } = await getFare({ table, key, origin, destination, stopsOrder, dOff, rOff, departDate, returnDate });
    if (!row) {
      const err = new Error("Over daily API budget and nothing cached for this cell yet.");
      err.code = "OVER_BUDGET";
      throw err;
    }
    return { total: row.total, legs: row.legs };
  };
}

const fetchForGrid = makeCachedFetcher("fareCache");
const fetchForOptions = makeCachedFetcher("tripPriceCache");

/** GET /api/fare-grid — tier 1, one cache-through fetch per cell (plan §3). */
export async function getGrid({ stops, origin, destination }) {
  return buildMatrix(stops, origin, destination, undefined, fetchForGrid);
}

/**
 * GET /api/fare-options — cache-only, always free (plan §8). Returns whatever
 * permutations have already been priced for this exact route + date pair,
 * which is nothing until someone has called checkOptions() for it at least once.
 */
export function getCheckedOptions({ origin, destination, stops, dOff, rOff }) {
  const { departDate, returnDate } = cacheKeyFor(origin, destination, stops, dOff, rOff);
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
export async function checkOptions({ stops, origin, destination, dOff, rOff }) {
  return generateOptions(stops, origin, destination, dOff, rOff, fetchForOptions);
}

/** POST /api/fare-cell/refresh — bypasses TTL, still gated by the budget cap. */
export async function refreshCell({ stops, origin, destination, dOff, rOff }) {
  const { key, departDate, returnDate } = cacheKeyFor(origin, destination, stops, dOff, rOff);
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
export function getItinerary({ stops, origin, destination, dOff, rOff, legs }) {
  return buildItineraryForOrder(dOff, rOff, stops, origin, destination, legs);
}
