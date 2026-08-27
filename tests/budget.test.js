// tests/budget.test.js
//
// Plan §11: "Budget guardrail: test that the cap blocks a Fetcher call before
// it fires, and that cache-only mode engages correctly once the cap is hit."
// Run with: npm test
//
// Uses a throwaway DB file (via DB_PATH) and a tiny cap (via API_DAILY_CAP) so
// this never touches the real dev database in server/data/db.json. Both env
// vars must be set before storage.js/budget.js are first imported, since they
// read them at module-load time — hence the dynamic imports below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TMP_DB = fileURLToPath(new URL("./tmp-budget-db.json", import.meta.url));
process.env.DB_PATH = TMP_DB;
process.env.API_DAILY_CAP = "3";

const { isOverBudget, checkBudgetAndRecord } = await import("../server/budget.js");
const { _resetForTests } = await import("../server/storage.js");

test.beforeEach(() => {
  _resetForTests();
});

test.after(() => {
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
});

test("budget: allows calls while under the cap", async () => {
  assert.equal(isOverBudget(), false);
  await checkBudgetAndRecord(() => Promise.resolve("ok"));
  assert.equal(isOverBudget(), false); // 1 of 3 used
});

test("budget: blocks a Fetcher call once the cap is hit, without ever running it", async () => {
  let fetcherRan = false;
  const fetcher = () => {
    fetcherRan = true;
    return Promise.resolve();
  };

  await checkBudgetAndRecord(fetcher);
  await checkBudgetAndRecord(fetcher);
  await checkBudgetAndRecord(fetcher); // cap is 3 — now exhausted
  assert.equal(isOverBudget(), true);

  fetcherRan = false;
  await assert.rejects(() => checkBudgetAndRecord(fetcher), /budget/i);
  assert.equal(fetcherRan, false, "the guarded function must not run once over budget");
});
