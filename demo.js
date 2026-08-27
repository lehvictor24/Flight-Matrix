// demo.js — run with: node demo.js
//
// Exercises the full pipeline the frontend needs: build the grid (tier 1),
// check other orders for one cell (tier 2, on demand), build an itinerary,
// and report the simulated API call count against a daily budget cap.

import { buildMatrix, generateOptions, buildItineraryForOrder, CITIES } from "./calculations.js";
import { getCallsMade, resetCallCounter } from "./mockFetcher.js";

const DAILY_CALL_CAP = 200; // matches §6 of the technical plan

async function main() {
  resetCallCounter();

  const origin = "rdu";
  const destination = "rdu";
  const stops = ["nrt", "tpe", "sin"];

  console.log(`Building grid for ${origin.toUpperCase()} -> ${stops.map(s => CITIES[s].code).join(" -> ")} -> ${destination.toUpperCase()} ...`);
  const matrix = await buildMatrix(stops, origin, destination);

  const cells = Object.entries(matrix);
  const cheapest = cells.reduce((a, b) => (b[1].total < a[1].total ? b : a));
  const priciest = cells.reduce((a, b) => (b[1].total > a[1].total ? b : a));

  console.log(`Grid built: ${cells.length} cells`);
  console.log(`  Cheapest: ${cheapest[0]} -> $${cheapest[1].total}`);
  console.log(`  Priciest: ${priciest[0]} -> $${priciest[1].total}`);
  console.log(`  Calls used so far: ${getCallsMade()} / ${DAILY_CALL_CAP}`);

  console.log(`\nChecking other orders for the 0_0 (exact-date) cell ...`);
  const options = await generateOptions(stops, origin, destination, 0, 0);
  options.forEach((o) => {
    console.log(`  ${o.isCheapest ? "* " : "  "}${o.label}: $${o.total}`);
  });
  console.log(`  Calls used so far: ${getCallsMade()} / ${DAILY_CALL_CAP}`);

  const best = options[0];
  const itinerary = buildItineraryForOrder(0, 0, best.order, origin, destination, best.legs);
  console.log(`\nItinerary for cheapest order (${itinerary.totalNights} nights total):`);
  itinerary.legs.forEach((leg, i) => {
    console.log(
      `  ${i + 1}. ${leg.fromCity} (${leg.from}) -> ${leg.toCity} (${leg.to}) ` +
      `| ${leg.depart.toDateString()} -> ${leg.arrive.toDateString()} | ${leg.airline} | $${leg.price}`
    );
  });

  console.log(`\nTotal simulated API calls this run: ${getCallsMade()}`);
  if (getCallsMade() > DAILY_CALL_CAP) {
    console.log("  ⚠ Over daily cap — real Fetcher would have switched to cache-only mode.");
  }
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
