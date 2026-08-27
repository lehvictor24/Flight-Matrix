// server/storage.js
//
// Local JSON-file-backed stand-in for the Postgres tables in plan §2 (fare_cache,
// trip_price_cache, api_usage, alerts). Zero external dependencies — just fs/path.
// Everything above this module only calls the functions below; swap this file for
// a real Postgres client later (plan §11) without touching cache.js, budget.js,
// or the route handlers.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimatedCostForCalls } from "./costModel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// DB_PATH is overridable so tests can point at a throwaway file instead of the
// real dev database (see tests/*.test.js).
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : join(__dirname, "data", "db.json");

const EMPTY_DB = {
  fareCache: {}, // cache_key -> { origin, destination, stops, departDate, returnDate, total, legs, fetchedAt }
  tripPriceCache: {}, // cache_key -> { origin, destination, stops, departDate, returnDate, orderSequence, total, legs, fetchedAt }
  apiUsage: {}, // day (YYYY-MM-DD) -> { callsMade, costEstimate, cacheHits, cacheMisses }
  alerts: [], // { id, routeSignature, thresholdPrice, active, lastTriggered }
};

function load() {
  if (!existsSync(DB_PATH)) return structuredClone(EMPTY_DB);
  try {
    return { ...structuredClone(EMPTY_DB), ...JSON.parse(readFileSync(DB_PATH, "utf8")) };
  } catch {
    return structuredClone(EMPTY_DB);
  }
}

let db = load();

function persist() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---- fare_cache (tier 1: single arranged order per route + dates) ----
export function getFareCacheRow(key) {
  return db.fareCache[key] ?? null;
}
export function setFareCacheRow(key, row) {
  db.fareCache[key] = row;
  persist();
}
export function getAllFareCacheRows() {
  return Object.values(db.fareCache);
}

// ---- trip_price_cache (tier 2: specific permutation ordering) ----
export function getTripPriceCacheRow(key) {
  return db.tripPriceCache[key] ?? null;
}
export function setTripPriceCacheRow(key, row) {
  db.tripPriceCache[key] = row;
  persist();
}
export function getAllTripPriceCacheRowsForRoute(routePrefix) {
  return Object.entries(db.tripPriceCache)
    .filter(([key]) => key.startsWith(routePrefix))
    .map(([, row]) => row);
}

// ---- api_usage (§2/§6 budget tracking + cost/usage monitor) ----
export function today() {
  return new Date().toISOString().slice(0, 10);
}
export function getApiUsage(day) {
  return db.apiUsage[day] ?? { callsMade: 0, costEstimate: 0, cacheHits: 0, cacheMisses: 0 };
}
export function incrementApiUsage(day) {
  const row = { ...getApiUsage(day) };
  row.callsMade += 1;
  row.costEstimate = estimatedCostForCalls(row.callsMade);
  db.apiUsage[day] = row;
  persist();
  return row;
}
export function recordCacheEvent(day, hit) {
  const row = { ...getApiUsage(day) };
  if (hit) row.cacheHits += 1;
  else row.cacheMisses += 1;
  db.apiUsage[day] = row;
  persist();
}
/** @param {string} monthPrefix - "YYYY-MM" */
export function getUsageForMonth(monthPrefix) {
  const totals = { callsMade: 0, costEstimate: 0, cacheHits: 0, cacheMisses: 0 };
  for (const [day, row] of Object.entries(db.apiUsage)) {
    if (!day.startsWith(monthPrefix)) continue;
    totals.callsMade += row.callsMade ?? 0;
    totals.costEstimate += row.costEstimate ?? 0;
    totals.cacheHits += row.cacheHits ?? 0;
    totals.cacheMisses += row.cacheMisses ?? 0;
  }
  return totals;
}
export function getAllUsageDays() {
  return db.apiUsage;
}

// ---- alerts (§9) ----
export function getAlerts() {
  return db.alerts;
}
export function addAlert({ routeSignature, thresholdPrice }) {
  const id = db.alerts.length ? Math.max(...db.alerts.map((a) => a.id)) + 1 : 1;
  const alert = { id, routeSignature, thresholdPrice, active: true, lastTriggered: null };
  db.alerts.push(alert);
  persist();
  return alert;
}
export function markAlertTriggered(id) {
  const alert = db.alerts.find((a) => a.id === id);
  if (alert) {
    alert.lastTriggered = new Date().toISOString();
    persist();
  }
}

/** Test-only: reset in-memory state without touching whatever DB_PATH points at. */
export function _resetForTests() {
  db = structuredClone(EMPTY_DB);
}
