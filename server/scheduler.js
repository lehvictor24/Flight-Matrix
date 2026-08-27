// server/scheduler.js
//
// Nightly bulk refresh (plan §7), constrained to the diagonal (fixed trip
// length — depart and return offsets move together) instead of the full 11x11
// cross product, to keep call volume low. Goes through the same getFare()
// wrapper as everything else — no separate path that could bypass the cache
// or the budget check.
//
// Run once:              node server/scheduler.js
// Run forever (no real cron/external deps needed, "for now"):
//                         node server/scheduler.js --loop

import { OFFSETS, DEPART_CENTER, RETURN_CENTER } from "../calculations.js";
import { getFare } from "./cache.js";

const DEFAULT_ROUTE = { origin: "rdu", destination: "rdu", stops: ["nrt", "tpe", "sin"] };

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function refreshDiagonal({ origin, destination, stops }) {
  let refreshed = 0;
  for (const offset of OFFSETS) {
    const departDate = isoDate(addDays(DEPART_CENTER, offset));
    const returnDate = isoDate(addDays(RETURN_CENTER, offset)); // diagonal: trip length stays fixed
    const key = `${origin}|${destination}|${stops.join(",")}|${departDate}|${returnDate}`;
    const { state } = await getFare({
      table: "fareCache",
      key,
      origin,
      destination,
      stopsOrder: stops,
      dOff: offset,
      rOff: offset,
      departDate,
      returnDate,
    });
    if (state === "fetched") refreshed += 1;
  }
  return refreshed;
}

export async function runSchedulerOnce(route = DEFAULT_ROUTE) {
  const count = await refreshDiagonal(route);
  console.log(
    `[scheduler] ${new Date().toISOString()} — refreshed ${count} diagonal cells for ` +
      `${route.origin}->${route.stops.join(",")}->${route.destination}`
  );
  return count;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const loop = process.argv.includes("--loop");
  runSchedulerOnce();
  if (loop) {
    console.log("[scheduler] looping every 24h (Ctrl+C to stop)...");
    setInterval(() => runSchedulerOnce(), 24 * 60 * 60 * 1000);
  }
}
