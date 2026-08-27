// server/usageMonitor.js
//
// Cost/usage monitor (plan §11 "Monitoring"): today's calls vs the daily cap,
// estimated cost (server/costModel.js — mockFetcher.js never hits a real paid
// API, so this is an ESTIMATE, "for now"), month-to-date spend against the
// estimated monthly budget, and cache hit rate.
//
// Run: node server/usageMonitor.js  (or npm run usage)

import { getBudgetStatus } from "./budget.js";

function bar(pct, width = 24) {
  const filled = Math.round((Math.min(pct, 100) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function main() {
  const s = getBudgetStatus();
  const dailyPct = (s.callsMade / s.cap) * 100;
  const monthlyPct = s.monthlyBudgetUsd > 0 ? (s.costThisMonthUsd / s.monthlyBudgetUsd) * 100 : 0;

  console.log(`Flight Matrix — API usage monitor (${s.day})`);
  console.log(`  Prices are mockFetcher.js's simulated fares; cost figures below are an ESTIMATE`);
  console.log(`  (server/costModel.js, $${s.costPerCallUsd.toFixed(3)}/call) — not a real invoice.\n`);

  console.log(`Today`);
  console.log(`  Calls:      ${s.callsMade} / ${s.cap}  ${bar(dailyPct)}  ${dailyPct.toFixed(0)}%`);
  console.log(`  Est. cost:  $${s.costTodayUsd.toFixed(2)}`);
  if (s.overBudget) console.log(`  ⚠ Over the daily cap — cache-only mode is in effect.`);

  console.log(`\nMonth to date (${s.month})`);
  console.log(`  Calls:      ${s.callsThisMonth}`);
  console.log(
    `  Est. cost:  $${s.costThisMonthUsd.toFixed(2)} / $${s.monthlyBudgetUsd.toFixed(2)}  ${bar(monthlyPct)}  ${monthlyPct.toFixed(0)}%`
  );
  console.log(`  Remaining:  $${s.monthlyBudgetRemainingUsd.toFixed(2)} (estimated)`);
  console.log(
    `  Cache hit rate: ${s.cacheHitRatePctThisMonth === null ? "n/a (no lookups yet)" : `${s.cacheHitRatePctThisMonth.toFixed(1)}%`}`
  );
}

main();
