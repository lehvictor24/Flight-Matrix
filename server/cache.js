// server/cache.js
//
// getFare() is the ONLY entry point above this layer for turning a
// (route, dates, stop order) tuple into a price. Implements plan §3:
//   fresh   -> return immediately, no Fetcher call
//   stale   -> return the stale value immediately, refresh in the background
//              (the caller never blocks on the refresh)
//   missing -> fetch synchronously (through dedupe + budget) and cache it
//
// mockFetcher.js stands in for the real SerpApi Fetcher (plan §5/§12) — nothing
// in this file talks to a real API, "for now" per the current build phase.

import { fetchFare } from "../mockFetcher.js";
import { dedupe } from "./dedupe.js";
import { checkBudgetAndRecord, isOverBudget } from "./budget.js";
import { getFareCacheRow, setFareCacheRow, getTripPriceCacheRow, setTripPriceCacheRow } from "./storage.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** TTL by volatility (§3) — prices closer to departure move faster. */
export function ttlFor(departDate) {
  const daysOut = (new Date(departDate) - Date.now()) / DAY;
  if (daysOut < 14) return 9 * HOUR; // 6-12h bucket, midpoint
  if (daysOut < 60) return 24 * HOUR;
  return 48 * HOUR;
}

/** Classifies an existing row as fresh/stale/missing against its TTL bucket. */
export function freshness(row, departDate) {
  if (!row) return "missing";
  const age = Date.now() - new Date(row.fetchedAt).getTime();
  return age < ttlFor(departDate) ? "fresh" : "stale";
}

function readRowFor(table) {
  return table === "fareCache" ? getFareCacheRow : getTripPriceCacheRow;
}
function writeRowFor(table) {
  return table === "fareCache" ? setFareCacheRow : setTripPriceCacheRow;
}

async function fetchAndStore({ table, key, origin, destination, stopsOrder, dOff, rOff, departDate, returnDate }) {
  const result = await checkBudgetAndRecord(() => fetchFare({ origin, destination, stopsOrder, dOff, rOff }));
  const row = {
    origin,
    destination,
    stops: stopsOrder,
    orderSequence: stopsOrder,
    departDate,
    returnDate,
    total: result.total,
    legs: result.legs,
    fetchedAt: new Date().toISOString(),
  };
  writeRowFor(table)(key, row);
  return row;
}

/**
 * @param {"fareCache"|"tripPriceCache"} table - which table this lookup belongs to
 * @returns {Promise<{row: object|null, state: "fresh"|"stale"|"fetched"|"missing-over-budget"}>}
 */
export async function getFare({ table, key, origin, destination, stopsOrder, dOff, rOff, departDate, returnDate }) {
  const existing = readRowFor(table)(key);
  const state = freshness(existing, departDate);

  if (state === "fresh") return { row: existing, state };

  if (state === "stale") {
    if (!isOverBudget()) {
      // Stale-while-revalidate: fire-and-forget, failures don't affect this read.
      dedupe(`${table}:${key}`, () =>
        fetchAndStore({ table, key, origin, destination, stopsOrder, dOff, rOff, departDate, returnDate })
      ).catch(() => {});
    }
    return { row: existing, state };
  }

  // missing
  if (isOverBudget()) {
    // Plan §6: over cap -> cache-only mode, never error outward from here.
    return { row: null, state: "missing-over-budget" };
  }
  const row = await dedupe(`${table}:${key}`, () =>
    fetchAndStore({ table, key, origin, destination, stopsOrder, dOff, rOff, departDate, returnDate })
  );
  return { row, state: "fetched" };
}

/** Manual per-cell refresh (§10): bypasses TTL, still gated by the same budget cap. */
export async function forceRefreshFare(args) {
  if (isOverBudget()) return { row: null, state: "missing-over-budget" };
  const row = await dedupe(`${args.table}:${args.key}:force`, () => fetchAndStore(args));
  return { row, state: "refreshed" };
}
