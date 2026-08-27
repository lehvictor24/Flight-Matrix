// mockFetcher.js
//
// Stand-in for the real SerpApi Fetcher described in the technical plan (§5, §12).
// Same call signature and return shape a live Fetcher would use — swap this module
// out for the real one later without touching the calculation layer or the frontend.
//
// Set USE_LIVE_API=true in env to make fetchFare() throw instead of returning mock
// data, so it's obvious if something accidentally tries to go live during local dev.

// Works in Node (reads env) and the browser (no process global, so it's always
// mock mode client-side — the real Fetcher lives server-side once §8's routes exist).
const USE_LIVE_API =
  typeof process !== "undefined" && process.env && process.env.USE_LIVE_API === "true";

// Tracks calls made this process — stands in for the api_usage table (§2/§6).
// A real Fetcher increments a Postgres counter here instead.
let callsMade = 0;
function getCallsMade() {
  return callsMade;
}
function resetCallCounter() {
  callsMade = 0;
}

// Rough per-city one-way baseline, just enough spread to make grids/orderings
// look organic. Extend freely — the Fetcher doesn't care what's in here.
const CITY_BASE = {
  nrt: 480, tpe: 550, sin: 760, hkg: 620, icn: 510,
  bkk: 700, mnl: 640, kul: 780, sgn: 690,
};
const ORIGIN_FACTOR = {
  rdu: 1.0, jfk: 0.92, ord: 0.95, atl: 0.97, dfw: 0.93,
  lax: 0.78, sfo: 0.75, sea: 0.8,
};
const AIRLINES = [
  "ANA", "EVA Air", "Singapore Airlines", "United", "Delta",
  "Korean Air", "Cathay Pacific", "China Airlines", "JAL",
];

function rand(min, max) {
  return min + Math.random() * (max - min);
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function simulatedNetworkDelay() {
  // 150-500ms, roughly what a real SerpApi call feels like
  return new Promise((res) => setTimeout(res, rand(150, 500)));
}

/**
 * Simulates one SerpApi search for a single specific ordering of stops on a
 * specific depart/return offset pair. This is the unit of cost — one call here
 * is one call against a real daily budget cap (§6).
 *
 * @param {object} params
 * @param {string} params.origin - origin key, e.g. "rdu"
 * @param {string} params.destination - destination key, e.g. "rdu"
 * @param {string[]} params.stopsOrder - ordered stop keys, e.g. ["nrt","tpe","sin"]
 * @param {number} params.dOff - depart date offset from center date
 * @param {number} params.rOff - return date offset from center date
 * @returns {Promise<{total:number, legs:Array, raw_response:object}>}
 */
export async function fetchFare({ origin, destination, stopsOrder, dOff, rOff }) {
  if (USE_LIVE_API) {
    throw new Error(
      "USE_LIVE_API=true but mockFetcher.fetchFare() was called. " +
      "Wire the real SerpApi Fetcher before setting this flag, or unset it for local dev."
    );
  }

  await simulatedNetworkDelay();
  callsMade += 1;

  const originFactor = ORIGIN_FACTOR[origin] ?? 1.0;
  const destFactor = ORIGIN_FACTOR[destination] ?? 1.0;

  // One randomized "leg price" per hop: origin -> stop1 -> stop2 -> ... -> destination
  const legs = [];
  let prevBase = CITY_BASE[stopsOrder[0]] * originFactor;

  for (let i = 0; i < stopsOrder.length; i++) {
    const cityBase = CITY_BASE[stopsOrder[i]];
    const legPrice = Math.round(
      (i === 0 ? cityBase * originFactor : (prevBase + cityBase) * 0.22) * rand(0.85, 1.2)
    );
    legs.push({
      from: i === 0 ? origin : stopsOrder[i - 1],
      to: stopsOrder[i],
      price: legPrice,
      airline: pick(AIRLINES),
    });
    prevBase = cityBase;
  }

  // final leg: last stop -> destination
  const lastBase = CITY_BASE[stopsOrder[stopsOrder.length - 1]];
  const finalLegPrice = Math.round(lastBase * destFactor * 1.05 * rand(0.85, 1.2));
  legs.push({
    from: stopsOrder[stopsOrder.length - 1],
    to: destination,
    price: finalLegPrice,
    airline: pick(AIRLINES),
  });

  // date-proximity and trip-length noise, same shape as the prototype's fake curve
  const peakPull = (5 - Math.abs(dOff)) * 26 + (5 - Math.abs(rOff)) * 26;
  const tripLength = 17 + (rOff - dOff);
  const lengthPenalty = Math.abs(tripLength - 17) * 10;
  const noise = rand(-80, 80);

  const legTotal = legs.reduce((sum, l) => sum + l.price, 0);
  const total = Math.max(150, Math.round(legTotal + peakPull + lengthPenalty * 0.4 + noise));

  return {
    total,
    legs,
    raw_response: {
      // placeholder for whatever shape SerpApi's real payload has —
      // keeping it here means the parsing boundary is already isolated
      mock: true,
      query: { origin, destination, stopsOrder, dOff, rOff },
      fetched_at: new Date().toISOString(),
    },
  };
}

export { getCallsMade, resetCallCounter, USE_LIVE_API };
