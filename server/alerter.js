// server/alerter.js
//
// Reads active alerts (plan §9) against whatever's currently in fare_cache and
// logs a notification (stands in for email/Slack — zero external deps "for
// now") when a threshold is crossed. Runs entirely off cached data — zero
// additional API cost, matching the plan exactly.
//
// Run: node server/alerter.js

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAlerts, markAlertTriggered, getAllFareCacheRows } from "./storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, "data", "alerts.log");

function cheapestForRoute(routeSignature) {
  const [origin, destination, stopsCsv] = routeSignature.split("|");
  const stops = stopsCsv.split(",");
  let cheapest = null;
  for (const row of getAllFareCacheRows()) {
    if (row.origin !== origin || row.destination !== destination) continue;
    if (row.stops.length !== stops.length || !stops.every((s) => row.stops.includes(s))) continue;
    if (!cheapest || row.total < cheapest.total) cheapest = row;
  }
  return cheapest;
}

export function runAlerterOnce() {
  const alerts = getAlerts().filter((a) => a.active);
  let triggered = 0;

  for (const alert of alerts) {
    const cheapest = cheapestForRoute(alert.routeSignature);
    if (cheapest && cheapest.total <= alert.thresholdPrice) {
      const line = `${new Date().toISOString()} ALERT: ${alert.routeSignature} is $${cheapest.total} (<= threshold $${alert.thresholdPrice})\n`;
      mkdirSync(dirname(LOG_PATH), { recursive: true });
      appendFileSync(LOG_PATH, line);
      console.log(line.trim());
      markAlertTriggered(alert.id);
      triggered += 1;
    }
  }

  if (triggered === 0) {
    console.log(`[alerter] ${new Date().toISOString()} — no thresholds crossed (${alerts.length} active alerts checked)`);
  }
  return triggered;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAlerterOnce();
}
