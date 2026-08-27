// calculations.js
//
// Real calculation layer behind the flight-fare-grid.jsx prototype. Same output
// shapes the frontend already expects (grid[dOff_rOff], options arrays, itinerary
// legs) — the difference is these now go through a Fetcher (mockFetcher for now,
// a real SerpApi wrapper later) instead of pure client-side math.
//
// Cost tiers match the technical plan:
//   buildMatrix()      -> tier 1, one fetch per grid cell (§3 cache-first target)
//   generateOptions()  -> tier 2, one fetch per permutation, only run on demand (§8)

const { fetchFare } = require("./mockFetcher");

const OFFSETS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

const CITIES = {
  nrt: { code: "NRT", city: "Tokyo" },
  tpe: { code: "TPE", city: "Taipei" },
  sin: { code: "SIN", city: "Singapore" },
  hkg: { code: "HKG", city: "Hong Kong" },
  icn: { code: "ICN", city: "Seoul" },
  bkk: { code: "BKK", city: "Bangkok" },
  mnl: { code: "MNL", city: "Manila" },
  kul: { code: "KUL", city: "Kuala Lumpur" },
  sgn: { code: "SGN", city: "Ho Chi Minh City" },
};
const ORIGINS = {
  rdu: { code: "RDU", city: "Raleigh-Durham" },
  jfk: { code: "JFK", city: "New York" },
  ord: { code: "ORD", city: "Chicago" },
  atl: { code: "ATL", city: "Atlanta" },
  dfw: { code: "DFW", city: "Dallas" },
  lax: { code: "LAX", city: "Los Angeles" },
  sfo: { code: "SFO", city: "San Francisco" },
  sea: { code: "SEA", city: "Seattle" },
};

const DEPART_CENTER = new Date(2026, 11, 17); // Dec 17, 2026
const RETURN_CENTER = new Date(2027, 0, 3); // Jan 3, 2027

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function distributeNights(total, n) {
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

// All orderings of a set of stops.
function permute(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  arr.forEach((item, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    permute(rest).forEach((p) => result.push([item, ...p]));
  });
  return result;
}

/**
 * Price ONE specific ordering of stops for ONE date pair. This is the unit
 * that costs a real API call — everything else composes calls to this.
 */
async function computePriceForOrder(stopsOrder, origin, destination, dOff, rOff) {
  const result = await fetchFare({ origin, destination, stopsOrder, dOff, rOff });
  return {
    order: stopsOrder,
    total: result.total,
    legs: result.legs, // [{from, to, price, airline}]
    legBase: result.legs.map((l) => l.price),
    baseTotal: result.legs.reduce((s, l) => s + l.price, 0),
  };
}

/**
 * TIER 1 — cheap grid pricing. One fetch per cell, using the single stop
 * order passed in (not every permutation). Matches §3 of the plan: this is
 * the only pricing that should run automatically for a whole grid.
 */
async function buildMatrix(stops, origin, destination) {
  const grid = {};
  // Sequential to keep this simple and obviously rate-limited; a real Fetcher
  // would batch/dedupe per §4-§5 instead of firing 121 calls in parallel.
  for (const dOff of OFFSETS) {
    for (const rOff of OFFSETS) {
      const priced = await computePriceForOrder(stops, origin, destination, dOff, rOff);
      grid[`${dOff}_${rOff}`] = {
        total: priced.total,
        legBase: priced.legBase,
        baseTotal: priced.baseTotal,
        order: stops,
      };
    }
  }
  return grid;
}

/**
 * TIER 2 — expensive permutation search. One fetch per possible ordering.
 * Only call this from the explicit "check other orders" action (§8), never
 * automatically per grid cell.
 */
async function generateOptions(stops, origin, destination, dOff, rOff) {
  if (stops.length > 1) {
    const orders = permute(stops);
    const priced = [];
    for (const order of orders) {
      priced.push(await computePriceForOrder(order, origin, destination, dOff, rOff));
    }
    priced.sort((a, b) => a.total - b.total);
    return priced.map((p, i) => ({
      ...p,
      label: p.order.map((s) => CITIES[s].city).join(" \u2192 "),
      isCheapest: i === 0,
    }));
  }

  // Round trip: one real fetch, then a couple of plausible carrier-mix
  // variants derived from it rather than separate paid calls each.
  const base = await computePriceForOrder(stops, origin, destination, dOff, rOff);
  const variants = [
    { label: "Best value", mult: 1.0 },
    { label: "Fewer connections", mult: 1.09 },
    { label: "Budget carrier mix", mult: 0.93 },
  ];
  const priced = variants.map((v) => ({
    order: stops,
    total: Math.round(base.total * v.mult),
    legBase: base.legBase.map((b) => b * v.mult),
    baseTotal: base.baseTotal * v.mult,
    label: v.label,
  }));
  priced.sort((a, b) => a.total - b.total);
  return priced.map((p, i) => ({ ...p, isCheapest: i === 0 }));
}

/**
 * Pure calculation, no fetch needed — builds the leg-by-leg itinerary
 * (dates, airlines, per-leg price) for a chosen ordering, using the leg
 * prices already returned by computePriceForOrder.
 */
function buildItineraryForOrder(dOff, rOff, stopsOrder, origin, destination, legs) {
  const totalNights = 17 + (rOff - dOff);
  const nightsPerStop = distributeNights(totalNights, stopsOrder.length);
  const originInfo = ORIGINS[origin];
  const destInfo = ORIGINS[destination];

  const itineraryLegs = [];
  let cursor = addDays(DEPART_CENTER, dOff);
  let fromCode = originInfo.code;
  let fromCity = originInfo.city;

  stopsOrder.forEach((s, i) => {
    const arrive = i === 0 ? addDays(cursor, 1) : cursor;
    itineraryLegs.push({
      from: fromCode,
      to: CITIES[s].code,
      fromCity,
      toCity: CITIES[s].city,
      depart: cursor,
      arrive,
      airline: legs[i].airline,
      price: legs[i].price,
    });
    cursor = addDays(arrive, nightsPerStop[i]);
    fromCode = CITIES[s].code;
    fromCity = CITIES[s].city;
  });

  const arriveFinal = addDays(cursor, 1);
  itineraryLegs.push({
    from: fromCode,
    to: destInfo.code,
    fromCity,
    toCity: destInfo.city,
    depart: cursor,
    arrive: arriveFinal,
    airline: legs[stopsOrder.length].airline,
    price: legs[stopsOrder.length].price,
  });

  return { legs: itineraryLegs, nightsPerStop, totalNights };
}

module.exports = {
  OFFSETS,
  CITIES,
  ORIGINS,
  buildMatrix,
  generateOptions,
  computePriceForOrder,
  buildItineraryForOrder,
  permute,
};
