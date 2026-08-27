// tests/get-fare-integration.test.js
//
// Plan §11: "Integration test for the full get_fare() path against a mocked
// SerpApi response." mockFetcher.js IS that mocked response source (it stands
// in for SerpApi per plan §5/§12), so this exercises getFare() end-to-end
// against it: missing -> fetched -> cached fresh -> force-refreshed.
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TMP_DB = fileURLToPath(new URL("./tmp-integration-db.json", import.meta.url));
process.env.DB_PATH = TMP_DB;
process.env.API_DAILY_CAP = "50";

const { getFare, forceRefreshFare } = await import("../server/cache.js");
const { getApiUsage } = await import("../server/storage.js");

test.after(() => {
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
});

function today() {
  return new Date().toISOString().slice(0, 10);
}

const args = {
  table: "fareCache",
  key: "rdu|rdu|nrt,tpe,sin|2026-12-17|2027-01-03",
  origin: "rdu",
  destination: "rdu",
  stopsOrder: ["nrt", "tpe", "sin"],
  dOff: 0,
  rOff: 0,
  departDate: "2026-12-17",
  returnDate: "2027-01-03",
};

test("getFare: missing -> fetches through mockFetcher and caches the row", async () => {
  const { row, state } = await getFare(args);
  assert.equal(state, "fetched");
  assert.ok(row.total > 0);
  assert.ok(Array.isArray(row.legs) && row.legs.length === args.stopsOrder.length + 1);
});

test("getFare: fresh -> returns the cached row without a new Fetcher call", async () => {
  const before = getApiUsage(today()).callsMade;
  const { state } = await getFare(args);
  const after = getApiUsage(today()).callsMade;
  assert.equal(state, "fresh");
  assert.equal(after, before, "a fresh read must not increment api_usage");
});

test("forceRefreshFare: bypasses freshness and always calls through", async () => {
  const before = getApiUsage(today()).callsMade;
  const { state } = await forceRefreshFare(args);
  const after = getApiUsage(today()).callsMade;
  assert.equal(state, "refreshed");
  assert.equal(after, before + 1, "a forced refresh must record exactly one new call");
});
