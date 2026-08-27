// demo.js — run with: node demo.js
//
// Exercises the full stack the frontend/server now use: build the grid (tier 1,
// through the cache/dedupe/budget layers), check other orders for one cell
// (tier 2, on demand), build an itinerary, and report real daily API usage
// (persisted in server/data/db.json, so it accumulates across runs the way a
// real api_usage table would) against the budget cap.

import { getGrid, checkOptions, getItinerary } from "./server/pricingService.js";
import { getBudgetStatus } from "./server/budget.js";
import { CITIES } from "./calculations.js";

async function main() {
  const origin = "rdu";
  const destination = "rdu";
  const stops = ["nrt", "tpe", "sin"];

  console.log(`Building grid for ${origin.toUpperCase()} -> ${stops.map((s) => CITIES[s].code).join(" -> ")} -> ${destination.toUpperCase()} ...`);
  const matrix = await getGrid({ origin, destination, stops });

  const cells = Object.entries(matrix);
  const cheapest = cells.reduce((a, b) => (b[1].total < a[1].total ? b : a));
  const priciest = cells.reduce((a, b) => (b[1].total > a[1].total ? b : a));

  console.log(`Grid built: ${cells.length} cells`);
  console.log(`  Cheapest: ${cheapest[0]} -> $${cheapest[1].total}`);
  console.log(`  Priciest: ${priciest[0]} -> $${priciest[1].total}`);
  logBudget();

  console.log(`\nChecking other orders for the 0_0 (exact-date) cell ...`);
  const options = await checkOptions({ origin, destination, stops, dOff: 0, rOff: 0 });
  options.forEach((o) => {
    console.log(`  ${o.isCheapest ? "* " : "  "}${o.label}: $${o.total}`);
  });
  logBudget();

  const best = options[0];
  const itinerary = getItinerary({ stops: best.order, origin, destination, dOff: 0, rOff: 0, legs: best.legs });
  console.log(`\nItinerary for cheapest order (${itinerary.totalNights} nights total):`);
  itinerary.legs.forEach((leg, i) => {
    console.log(
      `  ${i + 1}. ${leg.fromCity} (${leg.from}) -> ${leg.toCity} (${leg.to}) ` +
        `| ${leg.depart.toDateString()} -> ${leg.arrive.toDateString()} | ${leg.airline} | $${leg.price}`
    );
  });

  const status = getBudgetStatus();
  console.log(`\nTotal API calls today: ${status.callsMade} / ${status.cap}`);
  if (status.overBudget) {
    console.log("  ⚠ Over daily cap — cache-only mode is now in effect (see server/budget.js).");
  }
}

function logBudget() {
  const status = getBudgetStatus();
  console.log(`  Calls used today: ${status.callsMade} / ${status.cap}`);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
