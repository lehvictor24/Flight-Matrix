// server/budget.js
//
// Daily call cap (plan §6), checked before any Fetcher call fires — not after.
// Once the cap is hit, callers fall back to cache-only mode; this module never
// lets a call through past the cap. Default matches the plan's SerpApi Starter
// sizing; override with API_DAILY_CAP for a tighter dev cap (plan §12).
//
// Also exposes getBudgetStatus() — the cost/usage monitor (§11 "Monitoring")
// reads through here: today's calls vs cap, estimated cost (server/costModel.js),
// month-to-date totals against the estimated monthly budget, and cache hit rate.

import { getApiUsage, incrementApiUsage, getUsageForMonth, today } from "./storage.js";
import { COST_PER_CALL_USD, MONTHLY_BUDGET_USD, round2 } from "./costModel.js";

const DAILY_CALL_CAP = Number(process.env.API_DAILY_CAP) || 200;

export function isOverBudget() {
  return getApiUsage(today()).callsMade >= DAILY_CALL_CAP;
}

export function getBudgetStatus() {
  const day = today();
  const usage = getApiUsage(day);
  const month = day.slice(0, 7);
  const monthUsage = getUsageForMonth(month);
  const monthLookups = monthUsage.cacheHits + monthUsage.cacheMisses;

  return {
    day,
    callsMade: usage.callsMade,
    cap: DAILY_CALL_CAP,
    overBudget: usage.callsMade >= DAILY_CALL_CAP,
    costTodayUsd: usage.costEstimate ?? 0,
    costPerCallUsd: COST_PER_CALL_USD,
    month,
    callsThisMonth: monthUsage.callsMade,
    costThisMonthUsd: round2(monthUsage.costEstimate),
    monthlyBudgetUsd: MONTHLY_BUDGET_USD,
    monthlyBudgetRemainingUsd: round2(Math.max(0, MONTHLY_BUDGET_USD - monthUsage.costEstimate)),
    cacheHitRatePctThisMonth: monthLookups > 0 ? round2((monthUsage.cacheHits / monthLookups) * 100) : null,
  };
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
