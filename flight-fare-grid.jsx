import { useState, useMemo, useEffect, Fragment } from "react";

// ---------------------------------------------------------------------------
// Fake data generation — deterministic "pseudo-random" so the grid is stable
// across renders but still looks organic (mimics real fare curves: pricier
// near the exact holiday dates, cheaper as you drift away from them).
// ---------------------------------------------------------------------------

function seededNoise(x, y, seed) {
  const v = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

// Selectable origin airports. Each carries a rough cost factor relative to
// RDU (West coast airports sit closer to Asia and price lower; East coast
// hubs sit further and price about the same or slightly less than RDU).
const ORIGINS = {
  rdu: { code: "RDU", city: "Raleigh-Durham", factor: 1.0 },
  jfk: { code: "JFK", city: "New York", factor: 0.92 },
  ord: { code: "ORD", city: "Chicago", factor: 0.95 },
  atl: { code: "ATL", city: "Atlanta", factor: 0.97 },
  dfw: { code: "DFW", city: "Dallas", factor: 0.93 },
  lax: { code: "LAX", city: "Los Angeles", factor: 0.78 },
  sfo: { code: "SFO", city: "San Francisco", factor: 0.75 },
  sea: { code: "SEA", city: "Seattle", factor: 0.8 },
};
const DEFAULT_ORIGIN = "rdu";

// Selectable destination pool. Add more here to expand the dropdown options.
const CITIES = {
  nrt: { code: "NRT", city: "Tokyo", oneWayBase: 480 },
  tpe: { code: "TPE", city: "Taipei", oneWayBase: 550 },
  sin: { code: "SIN", city: "Singapore", oneWayBase: 760 },
  hkg: { code: "HKG", city: "Hong Kong", oneWayBase: 620 },
  icn: { code: "ICN", city: "Seoul", oneWayBase: 510 },
  bkk: { code: "BKK", city: "Bangkok", oneWayBase: 700 },
  mnl: { code: "MNL", city: "Manila", oneWayBase: 640 },
  kul: { code: "KUL", city: "Kuala Lumpur", oneWayBase: 780 },
  sgn: { code: "SGN", city: "Ho Chi Minh City", oneWayBase: 690 },
};

// Default stop order — matches what's been discussed so far.
const DEFAULT_MULTI_STOPS = ["nrt", "tpe", "sin"];
const DEFAULT_SINGLE_STOP = "nrt";
const MAX_MULTI_STOPS = 4;
const MIN_MULTI_STOPS = 2;

const OFFSETS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

const DEPART_CENTER = new Date(2026, 11, 17); // Dec 17, 2026 — leave RDU
const RETURN_CENTER = new Date(2027, 0, 3); // Jan 3, 2027 — arrive back RDU

// Evenly distribute total nights across N stops (remainder goes to the
// earliest stops so totals always sum exactly to totalNights).
function distributeNights(total, n) {
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDay(date) {
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

// All orderings of a set of stops — this is what lets the in-between
// cities be visited in any order rather than the order they were picked in.
function permute(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  arr.forEach((item, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    permute(rest).forEach((p) => result.push([item, ...p]));
  });
  return result;
}

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

// Order-sensitive seed so two different orderings of the same cities price
// differently (mimicking real fare variance by routing), while staying
// deterministic for a given order + date pair.
function orderSeed(stopsOrder) {
  return stopsOrder.reduce(
    (acc, s, i) => acc + (s.charCodeAt(0) + s.charCodeAt(1) * 2) * (i + 3) * 5,
    7
  );
}

const AIRLINES = [
  "ANA",
  "EVA Air",
  "Singapore Airlines",
  "United",
  "Delta",
  "Korean Air",
  "Cathay Pacific",
  "China Airlines",
  "JAL",
];

function airlineFor(seedNum, i) {
  const idx = Math.floor(seededNoise(seedNum, i, 3) * AIRLINES.length);
  return AIRLINES[Math.abs(idx) % AIRLINES.length];
}

// Price a single specific ordering of stops for a given depart/return offset
// pair. This is the core pricing function — everything else calls into it.
function computePriceForOrder(stopsOrder, origin, destination, dOff, rOff) {
  const originFactor = ORIGINS[origin].factor;
  const destFactor = ORIGINS[destination].factor;
  const baseCities = stopsOrder.map((s) => CITIES[s].oneWayBase);

  const legBase = [baseCities[0] * originFactor];
  for (let i = 0; i < stopsOrder.length - 1; i++) {
    legBase.push((baseCities[i] + baseCities[i + 1]) * 0.22);
  }
  legBase.push(baseCities[baseCities.length - 1] * destFactor * 1.05);

  const baseTotal = legBase.reduce((a, b) => a + b, 0);
  const peakPull = (5 - Math.abs(dOff)) * 26 + (5 - Math.abs(rOff)) * 26;
  const tripLength = 17 + (rOff - dOff);
  const lengthPenalty = Math.abs(tripLength - 17) * 10;
  const seed = orderSeed(stopsOrder) + origin.length * 13 + destination.length * 17;
  const noise = seededNoise(dOff + 6, rOff + 6, seed) * 160;
  const total = Math.round(baseTotal + peakPull + lengthPenalty * 0.4 + noise);

  return { order: stopsOrder, total, legBase, baseTotal };
}

// All available "flight options" for a given depart/return offset pair,
// sorted cheapest first. For multi-city trips this means every ordering of
// the in-between cities; for a simple round trip it means a few plausible
// carrier/routing alternatives on the same city pair.
function generateOptions(stops, origin, destination, dOff, rOff) {
  if (stops.length > 1) {
    const priced = permute(stops).map((order) =>
      computePriceForOrder(order, origin, destination, dOff, rOff)
    );
    priced.sort((a, b) => a.total - b.total);
    return priced.map((p, i) => ({
      ...p,
      label: p.order.map((s) => CITIES[s].city).join(" → "),
      isCheapest: i === 0,
      seedBase: orderSeed(p.order),
    }));
  }

  const base = computePriceForOrder(stops, origin, destination, dOff, rOff);
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
    seedBase: orderSeed(stops) + v.label.length,
  }));
  priced.sort((a, b) => a.total - b.total);
  return priced.map((p, i) => ({ ...p, isCheapest: i === 0 }));
}

// Build the full itinerary — one overnight long-haul leg out, same-day
// regional hops between stops, one overnight long-haul leg back — for any
// number of stops (1 = simple round trip, 2+ = multi-city loop) in a
// specific chosen order.
function buildItineraryForOrder(dOff, rOff, stopsOrder, origin, destination, seedBase) {
  const totalNights = 17 + (rOff - dOff);
  const nightsPerStop = distributeNights(totalNights, stopsOrder.length);
  const originInfo = ORIGINS[origin];
  const destInfo = ORIGINS[destination];

  const legs = [];
  let cursor = addDays(DEPART_CENTER, dOff);
  let fromCode = originInfo.code;
  let fromCity = originInfo.city;

  stopsOrder.forEach((s, i) => {
    const arrive = i === 0 ? addDays(cursor, 1) : cursor; // overnight only on the first leg
    legs.push({
      from: fromCode,
      to: CITIES[s].code,
      fromCity,
      toCity: CITIES[s].city,
      depart: cursor,
      arrive,
      airline: airlineFor(seedBase + i * 11, i),
    });
    cursor = addDays(arrive, nightsPerStop[i]);
    fromCode = CITIES[s].code;
    fromCity = CITIES[s].city;
  });

  // final leg: last stop -> final destination (overnight long-haul)
  const arriveFinal = addDays(cursor, 1);
  legs.push({
    from: fromCode,
    to: destInfo.code,
    fromCity,
    toCity: destInfo.city,
    depart: cursor,
    arrive: arriveFinal,
    airline: airlineFor(seedBase + stopsOrder.length * 11, stopsOrder.length),
  });

  return { legs, nightsPerStop, totalNights };
}

// Grid price for each depart/return cell uses the single order the stops are
// currently arranged in — cheap (one price lookup per cell), matching a real
// API's per-search cost. Cheaper orderings may exist, but finding them means
// searching every permutation, which is deferred to an explicit, cached,
// on-demand action (see generateOptions + the "Show other flight options"
// button) rather than run automatically for every grid cell.
function buildMatrix(stops, origin, destination) {
  const grid = {};
  OFFSETS.forEach((dOff) => {
    OFFSETS.forEach((rOff) => {
      const priced = computePriceForOrder(stops, origin, destination, dOff, rOff);
      grid[`${dOff}_${rOff}`] = {
        total: priced.total,
        legBase: priced.legBase,
        baseTotal: priced.baseTotal,
        order: stops,
      };
    });
  });
  return grid;
}

function colorForPrice(price, min, max) {
  const t = max === min ? 0 : (price - min) / (max - min);
  const stops = [
    { t: 0, c: [74, 222, 128] },
    { t: 0.5, c: [232, 163, 61] },
    { t: 1, c: [248, 113, 113] },
  ];
  let a = stops[0],
    b = stops[1];
  if (t > 0.5) {
    a = stops[1];
    b = stops[2];
  }
  const localT = (t - a.t) / (b.t - a.t || 1);
  const c = a.c.map((v, i) => Math.round(v + (b.c[i] - v) * localT));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Simulated cache age (hours since this fare was "fetched") — deterministic
// per cell + route so it stays stable across renders until manually
// refreshed. Stands in for a real fetched_at timestamp from a cache table.
function simulatedHoursAgo(dOff, rOff, stopsKey) {
  const seed = stopsKey.length * 31 + (dOff + 6) * 13 + (rOff + 6) * 7;
  return 1 + Math.floor(seededNoise(dOff + 6, rOff + 6, seed + 900) * 30);
}

function freshnessColor(hoursAgo) {
  if (hoursAgo <= 6) return "#4ADE80";
  if (hoursAgo <= 24) return "#E8A33D";
  return "#F87171";
}

export default function FlightFareGrid() {
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState(DEFAULT_ORIGIN);
  const [mode, setMode] = useState("multicity"); // "roundtrip" | "multicity"
  const [singleStop, setSingleStop] = useState(DEFAULT_SINGLE_STOP);
  const [multiStops, setMultiStops] = useState(DEFAULT_MULTI_STOPS);
  const [selected, setSelected] = useState({ dOff: 0, rOff: 0 });
  const [selectedOptionIndex, setSelectedOptionIndex] = useState(0);
  const [overrides, setOverrides] = useState({}); // cacheKey -> { jitterMult, refreshedAt }
  const [refreshingKey, setRefreshingKey] = useState(null);
  const [optionsCache, setOptionsCache] = useState({}); // fullCacheKey -> options array
  const [optionsLoadingKey, setOptionsLoadingKey] = useState(null);

  const stops = mode === "roundtrip" ? [singleStop] : multiStops;
  const stopsKey = origin + "|" + destination + "|" + mode + "|" + stops.join(",");
  const matrix = useMemo(
    () => buildMatrix(stops, origin, destination),
    [stopsKey]
  );

  function resetSelection() {
    setSelected({ dOff: 0, rOff: 0 });
    setSelectedOptionIndex(0);
  }

  function updateMultiStop(index, cityKey) {
    setMultiStops((prev) => {
      const next = [...prev];
      const dupeIndex = next.findIndex((c) => c === cityKey);
      if (dupeIndex !== -1 && dupeIndex !== index) {
        next[dupeIndex] = next[index];
      }
      next[index] = cityKey;
      return next;
    });
    resetSelection();
  }

  function addMultiStop() {
    if (multiStops.length >= MAX_MULTI_STOPS) return;
    const unused = Object.keys(CITIES).find((k) => !multiStops.includes(k));
    if (!unused) return;
    setMultiStops((prev) => [...prev, unused]);
    resetSelection();
  }

  function removeMultiStop(index) {
    if (multiStops.length <= MIN_MULTI_STOPS) return;
    setMultiStops((prev) => prev.filter((_, i) => i !== index));
    resetSelection();
  }

  // Clear simulated "manual refresh" overrides and cached permutation
  // searches whenever the route config changes — both only make sense
  // against the matrix/options they were computed for. The exact-date cell
  // (offset 0,0) is seeded as already cached, standing in for "someone
  // already checked this popular date pair recently" — everything else
  // starts uncached until explicitly checked.
  useEffect(() => {
    setOverrides({});
    const seededKey = `${stopsKey}__0_0`;
    const seeded = generateOptions(stops, origin, destination, 0, 0);
    setOptionsCache({ [seededKey]: seeded });
  }, [stopsKey]);

  function refreshCell(dOff, rOff) {
    const key = `${dOff}_${rOff}`;
    setRefreshingKey(key);
    setTimeout(() => {
      const jitterPct = (seededNoise(dOff + 6, rOff + 6, Date.now() % 5000) - 0.5) * 0.06;
      setOverrides((prev) => ({
        ...prev,
        [key]: { jitterMult: 1 + jitterPct, refreshedAt: Date.now() },
      }));
      setRefreshingKey(null);
    }, 550);
  }

  function freshnessLabel(dOff, rOff) {
    const key = `${dOff}_${rOff}`;
    if (overrides[key]) {
      const mins = Math.max(0, Math.floor((Date.now() - overrides[key].refreshedAt) / 60000));
      return mins < 1 ? "Updated just now" : `Updated ${mins}m ago`;
    }
    return `Updated ${simulatedHoursAgo(dOff, rOff, stopsKey)}h ago`;
  }

  function freshnessHours(dOff, rOff) {
    const key = `${dOff}_${rOff}`;
    if (overrides[key]) return 0;
    return simulatedHoursAgo(dOff, rOff, stopsKey);
  }

  const displayMatrix = useMemo(() => {
    const out = {};
    Object.entries(matrix).forEach(([k, v]) => {
      const jitter = overrides[k]?.jitterMult ?? 1;
      out[k] = { ...v, total: Math.round(v.total * jitter) };
    });
    return out;
  }, [matrix, overrides]);

  const { min, max, cheapestKey } = useMemo(() => {
    let mn = Infinity,
      mx = -Infinity,
      ck = null;
    Object.entries(displayMatrix).forEach(([k, v]) => {
      if (v.total < mn) {
        mn = v.total;
        ck = k;
      }
      if (v.total > mx) mx = v.total;
    });
    return { min: mn, max: mx, cheapestKey: ck };
  }, [displayMatrix]);

  const [cheapDOff, cheapROff] = cheapestKey.split("_").map(Number);
  const originalTotal = displayMatrix["0_0"].total;
  const savings = originalTotal - displayMatrix[cheapestKey].total;

  const cellKey = `${selected.dOff}_${selected.rOff}`;
  const fullCacheKey = `${stopsKey}__${cellKey}`;
  const cellJitter = overrides[cellKey]?.jitterMult ?? 1;

  // The permutation search (all city orders) is expensive against a real
  // API, so it only runs when explicitly requested via the button below —
  // and once run for a given route+cell, the result is cached so revisiting
  // that cell (or switching away and back) never re-triggers it.
  function requestOptions() {
    if (optionsCache[fullCacheKey] || optionsLoadingKey) return;
    setOptionsLoadingKey(fullCacheKey);
    setTimeout(() => {
      const computed = generateOptions(
        stops,
        origin,
        destination,
        selected.dOff,
        selected.rOff
      ).map((o) => ({
        ...o,
        total: Math.round(o.total * cellJitter),
        legBase: o.legBase.map((b) => b * cellJitter),
      }));
      setOptionsCache((prev) => ({ ...prev, [fullCacheKey]: computed }));
      setOptionsLoadingKey(null);
    }, 600);
  }

  const revealedOptions = optionsCache[fullCacheKey];
  const isLoadingOptions = optionsLoadingKey === fullCacheKey;

  const matrixEntry = matrix[cellKey];
  const displayEntry = displayMatrix[cellKey];
  const defaultOption = {
    order: stops,
    total: displayEntry.total,
    legBase: matrixEntry.legBase,
    baseTotal: matrixEntry.baseTotal,
    label: stops.map((s) => CITIES[s].city).join(" → "),
    seedBase: orderSeed(stops),
    isCheapest: !revealedOptions,
  };

  const displayedOptions = revealedOptions ? revealedOptions.slice(0, 5) : [defaultOption];
  const activeOption = displayedOptions[selectedOptionIndex] || displayedOptions[0];

  const itinerary = useMemo(
    () =>
      buildItineraryForOrder(
        selected.dOff,
        selected.rOff,
        activeOption.order,
        origin,
        destination,
        activeOption.seedBase
      ),
    [selected, stopsKey, selectedOptionIndex, revealedOptions]
  );
  const legPrices = activeOption.legBase.map((b) =>
    Math.round((b / activeOption.baseTotal) * activeOption.total)
  );

  return (
    <div
      style={{
        fontFamily: "'IBM Plex Sans', sans-serif",
        background: "#0B0E11",
        minHeight: "100vh",
        color: "#E6E9ED",
        padding: "28px 20px 60px",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        .mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        .fare-cell { transition: transform 120ms ease, box-shadow 120ms ease; cursor: pointer; }
        .fare-cell:hover { transform: scale(1.08); z-index: 2; box-shadow: 0 0 0 2px rgba(255,255,255,0.6); }
        .fare-cell:focus-visible { outline: 2px solid #E8A33D; outline-offset: 2px; }
        .route-tab { transition: all 150ms ease; }
        .leg-row { animation: fadeIn 220ms ease both; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }
        ::-webkit-scrollbar { height: 10px; }
        ::-webkit-scrollbar-track { background: #14181D; }
        ::-webkit-scrollbar-thumb { background: #2A3138; border-radius: 6px; }
      `}</style>

      {/* Header */}
      <div style={{ maxWidth: 980, margin: "0 auto 24px" }}>
        <div style={{ borderBottom: "1px solid #22282F", paddingBottom: 18 }}>
          <div
            className="mono"
            style={{
              fontSize: 12,
              letterSpacing: "0.14em",
              color: "#E8A33D",
              marginBottom: 6,
              textTransform: "uppercase",
            }}
          >
            {mode === "roundtrip"
              ? `${ORIGINS[origin].code} round trip · Fare grid`
              : `${ORIGINS[origin].code} multi-city loop · Fare grid`}
          </div>
          <h1
            style={{
              fontSize: 26,
              fontWeight: 700,
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            {ORIGINS[origin].city} → {stops.map((s) => CITIES[s].city).join(" → ")} →{" "}
            {ORIGINS[destination].city}
          </h1>
        </div>
      </div>

      {/* Mode toggle */}
      <div style={{ maxWidth: 980, margin: "0 auto 16px", display: "flex", gap: 10 }}>
        {[
          { id: "roundtrip", label: "Round trip" },
          { id: "multicity", label: "Multi-city" },
        ].map((m) => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              className="route-tab"
              onClick={() => {
                setMode(m.id);
                resetSelection();
              }}
              style={{
                background: active ? "#1B2128" : "transparent",
                border: active ? "1px solid #E8A33D" : "1px solid #22282F",
                color: active ? "#F3E3C6" : "#9CA6B0",
                borderRadius: 8,
                padding: "10px 16px",
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontWeight: 600,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Destination pickers */}
      {mode === "multicity" && (
        <div style={{ maxWidth: 980, margin: "0 auto 10px", fontSize: 12, color: "#7C8691" }}>
          Pick which cities to include — the grid finds the cheapest order to visit them in.
        </div>
      )}
      <div
        style={{
          maxWidth: 980,
          margin: "0 auto 20px",
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <StopPicker
          value={origin}
          options={ORIGINS}
          accent="#5B6570"
          onChange={(cityKey) => {
            setOrigin(cityKey);
            resetSelection();
          }}
        />
        <Arrow />
        {mode === "roundtrip" ? (
          <StopPicker
            value={singleStop}
            onChange={(cityKey) => {
              setSingleStop(cityKey);
              resetSelection();
            }}
          />
        ) : (
          multiStops.map((s, i) => (
            <Fragment key={`stop-${i}`}>
              {i > 0 && <Arrow />}
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <StopPicker
                  value={s}
                  onChange={(cityKey) => updateMultiStop(i, cityKey)}
                />
                {multiStops.length > MIN_MULTI_STOPS && (
                  <button
                    onClick={() => removeMultiStop(i)}
                    aria-label={`Remove ${CITIES[s].city}`}
                    style={{
                      background: "transparent",
                      border: "1px solid #22282F",
                      color: "#7C8691",
                      borderRadius: 6,
                      width: 26,
                      height: 26,
                      cursor: "pointer",
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </Fragment>
          ))
        )}

        {mode === "multicity" && multiStops.length < MAX_MULTI_STOPS && (
          <button
            onClick={addMultiStop}
            style={{
              background: "transparent",
              border: "1px dashed #3E4650",
              color: "#9CA6B0",
              borderRadius: 8,
              padding: "9px 14px",
              fontFamily: "'IBM Plex Sans', sans-serif",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            + Add stop
          </button>
        )}

        <Arrow />
        <StopPicker
          value={destination}
          options={ORIGINS}
          accent="#5B6570"
          onChange={(cityKey) => {
            setDestination(cityKey);
            resetSelection();
          }}
        />
      </div>

      {/* Summary strip */}
      <div
        style={{
          maxWidth: 980,
          margin: "0 auto 22px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 12,
        }}
      >
        <SummaryCard
          label="Your dates (Dec 17 → Jan 3)"
          value={`$${originalTotal.toLocaleString()}`}
          sub="all 4 legs combined"
        />
        <SummaryCard
          label="Cheapest in this grid"
          value={`$${displayMatrix[cheapestKey].total.toLocaleString()}`}
          sub={`${formatDate(addDays(DEPART_CENTER, cheapDOff))} → ${formatDate(
            addDays(RETURN_CENTER, cheapROff)
          )}`}
          accent="#4ADE80"
        />
        <SummaryCard
          label="Potential savings"
          value={savings > 0 ? `$${savings.toLocaleString()}` : "$0"}
          sub={savings > 0 ? "vs. your original dates" : "already the best"}
          accent={savings > 0 ? "#4ADE80" : "#7C8691"}
        />
      </div>

      {/* Grid */}
      <div
        style={{
          maxWidth: 980,
          margin: "0 auto",
          overflowX: "auto",
          border: "1px solid #22282F",
          borderRadius: 10,
          background: "#0E1216",
        }}
      >
        <div style={{ minWidth: 780, padding: 18 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `100px repeat(${OFFSETS.length}, 1fr)`,
              gap: 4,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                color: "#5B6570",
                display: "flex",
                alignItems: "flex-end",
                paddingBottom: 6,
              }}
            >
              DEPART ↓ / RETURN →
            </div>
            {OFFSETS.map((rOff) => {
              const d = addDays(RETURN_CENTER, rOff);
              return (
                <div key={`col-${rOff}`} style={{ textAlign: "center", paddingBottom: 6 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: 12,
                      fontWeight: rOff === 0 ? 700 : 500,
                      color: rOff === 0 ? "#E8A33D" : "#C7CED6",
                    }}
                  >
                    {formatDate(d)}
                  </div>
                  <div style={{ fontSize: 10, color: "#5B6570" }}>{formatDay(d)}</div>
                </div>
              );
            })}

            {OFFSETS.map((dOff) => {
              const d = addDays(DEPART_CENTER, dOff);
              return (
                <Fragment key={`row-${dOff}`}>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                      paddingRight: 8,
                    }}
                  >
                    <div
                      className="mono"
                      style={{
                        fontSize: 12,
                        fontWeight: dOff === 0 ? 700 : 500,
                        color: dOff === 0 ? "#E8A33D" : "#C7CED6",
                        textAlign: "right",
                      }}
                    >
                      {formatDate(d)}
                    </div>
                    <div style={{ fontSize: 10, color: "#5B6570", textAlign: "right" }}>
                      {formatDay(d)}
                    </div>
                  </div>
                  {OFFSETS.map((rOff) => {
                    const entry = displayMatrix[`${dOff}_${rOff}`];
                    const isSelected = selected.dOff === dOff && selected.rOff === rOff;
                    const isOriginal = dOff === 0 && rOff === 0;
                    const isCheapest = dOff === cheapDOff && rOff === cheapROff;
                    const hoursAgo = freshnessHours(dOff, rOff);
                    return (
                      <button
                        key={`cell-${dOff}-${rOff}`}
                        className="fare-cell"
                        onClick={() => {
                          setSelected({ dOff, rOff });
                          setSelectedOptionIndex(0);
                        }}
                        style={{
                          position: "relative",
                          background: colorForPrice(entry.total, min, max),
                          border: isSelected
                            ? "2px solid #FFFFFF"
                            : isOriginal
                            ? "2px solid #E8A33D"
                            : isCheapest
                            ? "2px dashed #0B0E11"
                            : "1px solid rgba(0,0,0,0.15)",
                          borderRadius: 6,
                          padding: "8px 2px",
                          minHeight: 44,
                        }}
                        aria-label={`Depart ${formatDate(d)}, return ${formatDate(
                          addDays(RETURN_CENTER, rOff)
                        )}: $${entry.total} — ${freshnessLabel(dOff, rOff)}`}
                      >
                        <span
                          style={{
                            position: "absolute",
                            top: 3,
                            right: 3,
                            width: 5,
                            height: 5,
                            borderRadius: "50%",
                            background: freshnessColor(hoursAgo),
                          }}
                        />
                        <span className="mono" style={{ fontSize: 13, fontWeight: 700, color: "#0B0E11" }}>
                          {entry.total.toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={{ maxWidth: 980, margin: "18px auto 0", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 12, color: "#7C8691" }}>Cheaper</span>
        <div
          style={{
            width: 140,
            height: 10,
            borderRadius: 5,
            background: "linear-gradient(90deg, #4ADE80, #E8A33D, #F87171)",
          }}
        />
        <span style={{ fontSize: 12, color: "#7C8691" }}>Pricier</span>
        <span
          style={{
            marginLeft: 14,
            fontSize: 12,
            color: "#7C8691",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              border: "2px solid #E8A33D",
              borderRadius: 3,
              display: "inline-block",
            }}
          />
          your dates
        </span>
        <span
          style={{
            marginLeft: 14,
            fontSize: 12,
            color: "#7C8691",
            display: "flex",
            alignItems: "center",
            gap: 5,
            flexWrap: "wrap",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ADE80", display: "inline-block" }} />
          fresh
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#E8A33D", display: "inline-block", marginLeft: 6 }} />
          aging
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#F87171", display: "inline-block", marginLeft: 6 }} />
          stale
        </span>
      </div>

      {/* Freshness + manual refresh */}
      <div
        style={{
          maxWidth: 980,
          margin: "18px auto 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          background: "#14181D",
          border: "1px solid #22282F",
          borderRadius: 8,
          padding: "10px 14px",
        }}
      >
        <div
          className="mono"
          style={{ fontSize: 12, color: "#7C8691", display: "flex", alignItems: "center", gap: 8 }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: freshnessColor(freshnessHours(selected.dOff, selected.rOff)),
              display: "inline-block",
            }}
          />
          {freshnessLabel(selected.dOff, selected.rOff)} for this date pair
        </div>
        <button
          onClick={() => refreshCell(selected.dOff, selected.rOff)}
          disabled={refreshingKey === `${selected.dOff}_${selected.rOff}`}
          style={{
            background: "transparent",
            border: "1px solid #3E4650",
            color: "#C7CED6",
            borderRadius: 6,
            padding: "6px 12px",
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontWeight: 600,
            fontSize: 12,
            cursor:
              refreshingKey === `${selected.dOff}_${selected.rOff}` ? "default" : "pointer",
            opacity: refreshingKey === `${selected.dOff}_${selected.rOff}` ? 0.6 : 1,
          }}
        >
          {refreshingKey === `${selected.dOff}_${selected.rOff}` ? "Refreshing…" : "↻ Refresh price"}
        </button>
      </div>

      {/* Other flight options */}
      <div
        style={{
          maxWidth: 980,
          margin: "22px auto 0",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: "#7C8691",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {mode === "roundtrip"
            ? "Other flight options"
            : `Other city orders (${factorial(stops.length)} possible)`}
        </div>

        {!revealedOptions && (
          <div
            style={{
              background: "#14181D",
              border: "1px dashed #2E353D",
              borderRadius: 8,
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 12, color: "#7C8691", maxWidth: 480 }}>
              {mode === "roundtrip"
                ? "Showing the standard search result. Checking alternates looks up a few more fares for this date pair."
                : `Showing the order as arranged above. Checking other orders prices ${factorial(
                    stops.length
                  )} route combinations for this date pair — only done once per cell, then cached.`}
            </span>
            <button
              onClick={requestOptions}
              disabled={isLoadingOptions}
              style={{
                background: "transparent",
                border: "1px solid #3E4650",
                color: "#C7CED6",
                borderRadius: 6,
                padding: "7px 14px",
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontWeight: 600,
                fontSize: 12,
                cursor: isLoadingOptions ? "default" : "pointer",
                opacity: isLoadingOptions ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {isLoadingOptions
                ? "Checking…"
                : mode === "roundtrip"
                ? "Check alternates"
                : "Check other orders"}
            </button>
          </div>
        )}

        {revealedOptions &&
          displayedOptions.map((opt, i) => {
            const active = i === selectedOptionIndex;
            return (
              <button
                key={`${opt.label}-${i}`}
                onClick={() => setSelectedOptionIndex(i)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  background: active ? "#1B2128" : "#14181D",
                  border: active ? "1px solid #E8A33D" : "1px solid #22282F",
                  borderRadius: 8,
                  padding: "10px 14px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: active ? "#F3E3C6" : "#C7CED6",
                  }}
                >
                  {opt.label}
                  {opt.isCheapest && (
                    <span
                      className="mono"
                      style={{
                        marginLeft: 8,
                        fontSize: 10,
                        color: "#4ADE80",
                        border: "1px solid #2E6B45",
                        borderRadius: 4,
                        padding: "1px 5px",
                      }}
                    >
                      CHEAPEST
                    </span>
                  )}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 14, fontWeight: 700, color: "#E6E9ED" }}
                >
                  ${opt.total.toLocaleString()}
                </span>
              </button>
            );
          })}
        {revealedOptions && (
          <div className="mono" style={{ fontSize: 11, color: "#4B5560" }}>
            Cached — revisiting this date pair won't re-check orders.
          </div>
        )}
      </div>

      {/* Itinerary detail panel */}
      <div
        style={{
          maxWidth: 980,
          margin: "14px auto 0",
          background: "#14181D",
          border: "1px solid #22282F",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid #22282F",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#E6E9ED" }}>
              {activeOption.label} — {itinerary.totalNights} nights total
            </div>
            <div style={{ fontSize: 12, color: "#7C8691", marginTop: 2 }}>
              {activeOption.order
                .map((s, i) => `${CITIES[s].city} ${itinerary.nightsPerStop[i]}n`)
                .join(" · ")}
            </div>
          </div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: "#E8A33D" }}>
            ${activeOption.total.toLocaleString()}
          </div>
        </div>

        <div style={{ padding: "6px 0" }}>
          {itinerary.legs.map((leg, i) => (
            <div
              key={i}
              className="leg-row"
              style={{
                display: "grid",
                gridTemplateColumns: "28px 1fr auto",
                alignItems: "center",
                gap: 14,
                padding: "12px 18px",
                borderBottom: i < itinerary.legs.length - 1 ? "1px solid #1C2127" : "none",
                animationDelay: `${i * 40}ms`,
              }}
            >
              <div className="mono" style={{ fontSize: 11, color: "#5B6570", textAlign: "center" }}>
                {String(i + 1).padStart(2, "0")}
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {leg.fromCity} ({leg.from}) → {leg.toCity} ({leg.to})
                </div>
                <div className="mono" style={{ fontSize: 12, color: "#7C8691", marginTop: 3 }}>
                  Depart {formatDate(leg.depart)} ({formatDay(leg.depart)})
                  {"  →  "}
                  Arrive {formatDate(leg.arrive)} ({formatDay(leg.arrive)})
                  {"  ·  "}
                  {leg.airline}
                </div>
              </div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: "#C7CED6" }}>
                ${legPrices[i].toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: "20px auto 0", fontSize: 12, color: "#4B5560", lineHeight: 1.6 }}>
        Proof of concept — prices and schedules are synthetic. The grid always prices the
        stop order as arranged above — one lookup per date pair, matching what a real fare
        API would cost. Checking other city orders (or alternates for a round trip) is a
        separate, explicit action since it means pricing every possible ordering; once
        checked for a given date pair, the result is cached and won't be re-checked on
        revisit. The dot on each cell and the "Updated Xh ago" line simulate the same fare
        cache — prices go stale over time and only refresh when you click "Refresh price."
        Wire this to a real fare source to replace the fake data layer.
      </div>
    </div>
  );
}

function Arrow() {
  return <span style={{ color: "#3E4650", fontSize: 16 }}>→</span>;
}

function StopPicker({ value, onChange, options = CITIES, accent = "#E8A33D" }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: "#1B2128",
        border: `1px solid ${accent}`,
        color: "#F3E3C6",
        borderRadius: 8,
        padding: "9px 12px",
        fontFamily: "'IBM Plex Sans', sans-serif",
        fontWeight: 600,
        fontSize: 13,
        cursor: "pointer",
        appearance: "auto",
      }}
    >
      {Object.entries(options).map(([key, c]) => (
        <option key={key} value={key} style={{ background: "#1B2128" }}>
          {c.city} ({c.code})
        </option>
      ))}
    </select>
  );
}

function SummaryCard({ label, value, sub, accent = "#E6E9ED" }) {
  return (
    <div style={{ background: "#14181D", border: "1px solid #22282F", borderRadius: 10, padding: "14px 16px" }}>
      <div
        style={{
          fontSize: 11,
          color: "#7C8691",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: accent }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: "#7C8691", marginTop: 2 }}>{sub}</div>
    </div>
  );
}