// tests/dedupe.test.js
//
// Plan §11: "Dedupe layer: test that concurrent requests for the same key
// produce exactly one Fetcher call." Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe } from "../server/dedupe.js";

test("dedupe: concurrent calls for the same key share one execution", async () => {
  let calls = 0;
  const fn = () => {
    calls += 1;
    return new Promise((resolve) => setTimeout(() => resolve(calls), 20));
  };

  const [a, b, c] = await Promise.all([dedupe("route-x", fn), dedupe("route-x", fn), dedupe("route-x", fn)]);

  assert.equal(calls, 1, "only one real call should have fired");
  assert.deepEqual([a, b, c], [1, 1, 1], "all callers should get the same shared result");
});

test("dedupe: different keys run independently", async () => {
  let calls = 0;
  const fn = () => {
    calls += 1;
    return Promise.resolve(calls);
  };

  await Promise.all([dedupe("route-a", fn), dedupe("route-b", fn)]);

  assert.equal(calls, 2);
});

test("dedupe: a key can be requested again once the first call finishes", async () => {
  let calls = 0;
  const fn = () => {
    calls += 1;
    return Promise.resolve(calls);
  };

  await dedupe("route-y", fn);
  await dedupe("route-y", fn);

  assert.equal(calls, 2, "a completed key should not stay deduped forever");
});
