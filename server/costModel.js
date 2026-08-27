// server/costModel.js
//
// mockFetcher.js never hits a real paid API, so there's no real invoice to read
// cost from — this is an ESTIMATED price model, "for now," standing in for
// whatever SerpApi plan you're actually on. Override the env vars once you
// know real numbers; nothing else needs to change (budget.js and the usage
// monitor only import the two functions/constants below).
//
// Defaults are calibrated loosely against the plan's own cost math (§1/§12):
// $25/mo Starter plan, ~30-50 calls/day comfortably inside it.

const COST_PER_CALL_USD = Number(process.env.COST_PER_CALL_USD) || 0.01;
const MONTHLY_BUDGET_USD = Number(process.env.MONTHLY_BUDGET_USD) || 25;

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function estimatedCostForCalls(calls) {
  return round2(calls * COST_PER_CALL_USD);
}

export { COST_PER_CALL_USD, MONTHLY_BUDGET_USD, round2 };
