// server/budget.js
//
// Daily call cap (plan §6), checked before any Fetcher call fires — not after.
// Once the cap is hit, callers fall back to cache-only mode; this module never
// lets a call through past the cap. Default matches the plan's SerpApi Starter
// sizing; override with API_DAILY_CAP for a tighter dev cap (plan §12).

import { getApiUsage, incrementApiUsage } from "./storage.js";

const DAILY_CALL_CAP = Number(process.env.API_DAILY_CAP) || 200;

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function isOverBudget() {
  return getApiUsage(today()).callsMade >= DAILY_CALL_CAP;
}

export function getBudgetStatus() {
  const usage = getApiUsage(today());
  return { day: today(), callsMade: usage.callsMade, cap: DAILY_CALL_CAP, overBudget: usage.callsMade >= DAILY_CALL_CAP };
}

/**
 * Runs fn() only if under budget. The check and the increment happen with no
 * `await` between them, so — since Node runs this synchronously in one tick —
 * a burst of concurrent callers can't all slip through between "check" and
 * "record" the way they could if the increment were delayed.
 */
export async function checkBudgetAndRecord(fn) {
  if (isOverBudget()) {
    const err = new Error(`Daily API budget exceeded (${DAILY_CALL_CAP}/day) — cache-only mode should be used instead.`);
    err.code = "OVER_BUDGET";
    throw err;
  }
  incrementApiUsage(today());
  return fn();
}
