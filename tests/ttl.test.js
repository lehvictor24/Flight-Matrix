// tests/ttl.test.js
//
// Plan §11: "TTL logic: unit tests asserting fresh/stale/missing classification
// at each days-to-departure bucket." Run with: npm test (or node --test tests/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ttlFor, freshness } from "../server/cache.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function daysFromNow(days) {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

test("ttlFor: <14 days out uses the short (6-12h) bucket", () => {
  assert.equal(ttlFor(daysFromNow(9)), 9 * HOUR);
});

test("ttlFor: 14-60 days out uses the 24h bucket", () => {
  assert.equal(ttlFor(daysFromNow(30)), 24 * HOUR);
});

test("ttlFor: >60 days out uses the 48h+ bucket", () => {
  assert.equal(ttlFor(daysFromNow(90)), 48 * HOUR);
});

test("freshness: no row -> 'missing'", () => {
  assert.equal(freshness(null, daysFromNow(90)), "missing");
});

test("freshness: just-fetched row -> 'fresh'", () => {
  const row = { fetchedAt: new Date().toISOString() };
  assert.equal(freshness(row, daysFromNow(90)), "fresh");
});

test("freshness: row older than its TTL bucket -> 'stale', never silently 'fresh'", () => {
  // >60-day bucket TTL is 48h; a row fetched 49h ago must not be reported fresh —
  // this is the one bug that would make the app quietly show stale prices.
  const row = { fetchedAt: new Date(Date.now() - 49 * HOUR).toISOString() };
  assert.equal(freshness(row, daysFromNow(90)), "stale");
});

test("freshness: <14-day bucket row past its shorter TTL is stale sooner", () => {
  const row = { fetchedAt: new Date(Date.now() - 10 * HOUR).toISOString() };
  assert.equal(freshness(row, daysFromNow(9)), "stale");
});
