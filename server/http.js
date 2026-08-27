// server/http.js
//
// Real local HTTP server implementing plan §8's routes, using only Node's
// built-in http/url modules — zero external dependencies. Run with
// `npm run server` (or `node server/http.js`); Vite's dev server proxies
// /api/* to this process (see vite.config.js) so the frontend can just
// fetch("/api/...") the same way it would against a deployed backend.
//
// Every route here is backed by mockFetcher.js's randomized simulated fares
// (through cache.js/dedupe.js/budget.js) — no real external API is ever called.

import { createServer } from "node:http";
import { getGrid, getCheckedOptions, checkOptions, refreshCell, getItinerary } from "./pricingService.js";
import { getBudgetStatus } from "./budget.js";
import { getAlerts, addAlert } from "./storage.js";

const PORT = Number(process.env.PORT) || 8787;

// Dev-only rate limit on the one route that spends budget (plan §11):
// N checks/hour per caller, even though this never leaves localhost right now.
const CHECK_LIMIT_PER_HOUR = 30;
const checkHits = new Map(); // ip -> timestamps[]
function isRateLimited(ip) {
  const now = Date.now();
  const hits = (checkHits.get(ip) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  hits.push(now);
  checkHits.set(ip, hits);
  return hits.length > CHECK_LIMIT_PER_HOUR;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*", // dev convenience only — see plan §11 for real auth before this is ever public
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function parseStops(url) {
  return (url.searchParams.get("stops") ?? "").split(",").filter(Boolean);
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const ip = req.socket.remoteAddress ?? "unknown";

  try {
    if (req.method === "GET" && url.pathname === "/api/fare-grid") {
      const origin = url.searchParams.get("origin");
      const destination = url.searchParams.get("destination");
      const stops = parseStops(url);
      const grid = await getGrid({ origin, destination, stops });
      return send(res, 200, { grid });
    }

    if (req.method === "GET" && url.pathname === "/api/fare-options") {
      const origin = url.searchParams.get("origin");
      const destination = url.searchParams.get("destination");
      const stops = parseStops(url);
      const dOff = Number(url.searchParams.get("departOffset"));
      const rOff = Number(url.searchParams.get("returnOffset"));
      const options = getCheckedOptions({ origin, destination, stops, dOff, rOff });
      return send(res, 200, { options });
    }

    if (req.method === "POST" && url.pathname === "/api/fare-options/check") {
      if (isRateLimited(ip)) {
        return send(res, 429, { error: `Too many checks this hour (limit ${CHECK_LIMIT_PER_HOUR}). Try again later.` });
      }
      const body = await readJsonBody(req);
      const options = await checkOptions(body);
      return send(res, 200, { options });
    }

    if (req.method === "POST" && url.pathname === "/api/fare-cell/refresh") {
      const body = await readJsonBody(req);
      const result = await refreshCell(body);
      return send(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/api/itinerary") {
      const body = await readJsonBody(req);
      const itinerary = getItinerary(body);
      return send(res, 200, { itinerary });
    }

    if (req.method === "GET" && url.pathname === "/api/usage") {
      return send(res, 200, getBudgetStatus());
    }

    if (req.method === "GET" && url.pathname === "/api/alerts") {
      return send(res, 200, { alerts: getAlerts() });
    }

    if (req.method === "POST" && url.pathname === "/api/alerts") {
      const body = await readJsonBody(req);
      const alert = addAlert(body);
      return send(res, 201, alert);
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    if (err.code === "OVER_BUDGET") {
      return send(res, 503, { error: err.message, code: "OVER_BUDGET" });
    }
    console.error(err);
    send(res, 500, { error: "Internal error", detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Flight Matrix API listening on http://localhost:${PORT}`);
  console.log(`All data is mockFetcher.js's randomized simulated fares — no real API is ever called.`);
});
