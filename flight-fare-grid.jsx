import { useState, useMemo, useEffect, Fragment } from "react";
import { OFFSETS, CITIES, ORIGINS, DEPART_CENTER, RETURN_CENTER, buildItineraryForOrder } from "./calculations.js";

// ---------------------------------------------------------------------------
// Pricing comes from the local API server (server/http.js) via fetch() — see
// the technical plan §8/§10. That server is itself backed by mockFetcher.js's
// simulated SerpApi calls, routed through the cache/dedupe/budget layers
// (server/cache.js, dedupe.js, budget.js), so nothing here ever reaches a real
// external API. Only buildItineraryForOrder + static route metadata are still
// imported directly from calculations.js, since that's pure calculation with
// no Fetcher call involved — no need to round-trip it over the network.
//
// Run `npm run server` alongside `npm run dev` (or `./run.sh`, which starts
// both) — Vite proxies /api/* to it, see vite.config.js.
// ---------------------------------------------------------------------------

async function apiGetGrid(origin, destination, stops) {
  const params = new URLSearchParams({ origin, destination, stops: stops.join(",") });
  const res = await fetch(`/api/fare-grid?${params}`);
  if (!res.ok) throw new Error(`GET /api/fare-grid -> ${res.status}`);
  return (await res.json()).grid;
}

async function apiGetCheckedOptions(origin, destination, stops, dOff, rOff) {
  const params = new URLSearchParams({
    origin,
    destination,
    stops: stops.join(","),
    departOffset: String(dOff),
    returnOffset: String(rOff),
  });
  const res = await fetch(`/api/fare-options?${params}`);
  if (!res.ok) throw new Error(`GET /api/fare-options -> ${res.status}`);
  return (await res.json()).options;
}

async function apiCheckOptions(origin, destination, stops, dOff, rOff) {
  const res = await fetch(`/api/fare-options/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, destination, stops, dOff, rOff }),
  });
  if (!res.ok) throw new Error(`POST /api/fare-options/check -> ${res.status}`);
  return (await res.json()).options;
}

async function apiRefreshCell(origin, destination, stops, dOff, rOff) {
  const res = await fetch(`/api/fare-cell/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, destination, stops, dOff, rOff }),
  });
  if (!res.ok) throw new Error(`POST /api/fare-cell/refresh -> ${res.status}`);
  return res.json(); // { total, legs, order }
}

function seededNoise(x, y, seed) {
  const v = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

const DEFAULT_ORIGIN = "rdu";

// Default stop order — matches what's been discussed so far.
const DEFAULT_MULTI_STOPS = ["nrt", "tpe", "sin"];
const DEFAULT_SINGLE_STOP = "nrt";
const MAX_MULTI_STOPS = 4;
const MIN_MULTI_STOPS = 2;

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

function factorial(n) {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
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
  const [matrix, setMatrix] = useState({}); // dOff_rOff -> { total, legs, order }
  const [matrixError, setMatrixError] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState({}); // cacheKey -> timestamp, for manually-refreshed cells
  const [refreshingKey, setRefreshingKey] = useState(null);
  const [checkedOptions, setCheckedOptions] = useState([]); // GET /api/fare-options result for the selected cell
  const [isCheckingOptions, setIsCheckingOptions] = useState(false); // POST /api/fare-options/check in flight
  const [showRawData, setShowRawData] = useState(false);

  const stops = mode === "roundtrip" ? [singleStop] : multiStops;
  const stopsKey = origin + "|" + destination + "|" + mode + "|" + stops.join(",");

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

  // Rebuild the grid (tier 1 — GET /api/fare-grid, one cache-through lookup
  // per cell server-side) whenever the route config changes, and clear
  // anything that only makes sense against the previous matrix.
  useEffect(() => {
    let cancelled = false;
    setMatrix({});
    setMatrixError(null);
    setRefreshedAt({});

    apiGetGrid(origin, destination, stops)
      .then((grid) => {
        if (!cancelled) setMatrix(grid);
      })
      .catch((err) => {
        if (!cancelled) setMatrixError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [stopsKey]);

  const isMatrixLoading = Object.keys(matrix).length === 0 && !matrixError;

  // Whichever cell is selected, ask the server what's already been checked for
  // it (GET /api/fare-options — cache-only, always free, per plan §8). Runs
  // on every selection change so results stay live across sessions since the
  // server persists trip_price_cache to disk.
  useEffect(() => {
    let cancelled = false;
    apiGetCheckedOptions(origin, destination, stops, selected.dOff, selected.rOff)
      .then((options) => {
        if (!cancelled) setCheckedOptions(options);
      })
      .catch(() => {
        if (!cancelled) setCheckedOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [stopsKey, selected.dOff, selected.rOff]);

  async function refreshCell(dOff, rOff) {
    const key = `${dOff}_${rOff}`;
    setRefreshingKey(key);
    try {
      const result = await apiRefreshCell(origin, destination, stops, dOff, rOff);
      setMatrix((prev) => ({
        ...prev,
        [key]: { total: result.total, legs: result.legs, order: result.order },
      }));
      setRefreshedAt((prev) => ({ ...prev, [key]: Date.now() }));
    } finally {
      setRefreshingKey(null);
    }
  }

  function freshnessLabel(dOff, rOff) {
    const key = `${dOff}_${rOff}`;
    if (refreshedAt[key]) {
      const mins = Math.max(0, Math.floor((Date.now() - refreshedAt[key]) / 60000));
      return mins < 1 ? "Updated just now" : `Updated ${mins}m ago`;
    }
    return `Updated ${simulatedHoursAgo(dOff, rOff, stopsKey)}h ago`;
  }

  function freshnessHours(dOff, rOff) {
    const key = `${dOff}_${rOff}`;
    if (refreshedAt[key]) return 0;
    return simulatedHoursAgo(dOff, rOff, stopsKey);
  }

  const { min, max, cheapestKey } = useMemo(() => {
    let mn = Infinity,
      mx = -Infinity,
      ck = null;
    Object.entries(matrix).forEach(([k, v]) => {
      if (v.total < mn) {
        mn = v.total;
        ck = k;
      }
      if (v.total > mx) mx = v.total;
    });
    return { min: mn, max: mx, cheapestKey: ck };
  }, [matrix]);

  const cellKey = `${selected.dOff}_${selected.rOff}`;
  const revealedOptions = checkedOptions.length > 0 ? checkedOptions : null;
  const isLoadingOptions = isCheckingOptions;

  const matrixEntry = matrix[cellKey];
  const defaultOption = matrixEntry && {
    order: stops,
    total: matrixEntry.total,
    legs: matrixEntry.legs,
    label: stops.map((s) => CITIES[s].city).join(" → "),
    isCheapest: !revealedOptions,
  };

  const displayedOptions = revealedOptions ? revealedOptions.slice(0, 5) : [defaultOption].filter(Boolean);
  const activeOption = displayedOptions[selectedOptionIndex] || displayedOptions[0];

  // Hooks must run unconditionally every render, so this stays above the
  // loading early-return below and tolerates matrix not being ready yet.
  const itinerary = useMemo(
    () =>
      activeOption
        ? buildItineraryForOrder(
            selected.dOff,
            selected.rOff,
            activeOption.order,
            origin,
            destination,
            activeOption.legs
          )
        : { legs: [], nightsPerStop: [], totalNights: 0 },
    [selected, stopsKey, selectedOptionIndex, revealedOptions, activeOption]
  );

  if (isMatrixLoading || matrixError) {
    return (
      <LoadingScreen
        origin={origin}
        destination={destination}
        stops={stops}
        mode={mode}
        error={matrixError}
      />
    );
  }

  const [cheapDOff, cheapROff] = cheapestKey.split("_").map(Number);
  const originalTotal = matrix["0_0"].total;
  const cheapestTotal = matrix[cheapestKey].total;
  const savings = originalTotal - cheapestTotal;

  function datesForKey(key) {
    const [d, r] = key.split("_").map(Number);
    return { dOff: d, rOff: r, departDate: formatDate(addDays(DEPART_CENTER, d)), returnDate: formatDate(addDays(RETURN_CENTER, r)) };
  }
  const fullMatrixWithDates = Object.fromEntries(
    Object.entries(matrix).map(([key, entry]) => [key, { ...datesForKey(key), ...entry }])
  );
  const rawData = {
    dateLegend: "Keys are '{dOff}_{rOff}' offsets in days from the two center dates below — NOT literal dates.",
    centerDates: { departCenter: formatDate(DEPART_CENTER), returnCenter: formatDate(RETURN_CENTER) },
    route: { origin, destination, mode, stops },
    selectedCell: { ...datesForKey(cellKey), key: cellKey },
    selectedCellFetchedData: matrixEntry,
    cheapestCell: { ...datesForKey(cheapestKey), key: cheapestKey, total: cheapestTotal },
    gridMinMaxTotal: { min, max },
    optionsCheckedForSelectedCell: revealedOptions ?? null,
    activeOption,
    itinerary,
    fullMatrix: fullMatrixWithDates,
  };

  // The permutation search (all city orders) is expensive against a real API,
  // so it only runs when explicitly requested via the button below — POST
  // /api/fare-options/check (plan §8), which persists every result to
  // trip_price_cache so revisiting this cell (or reloading the page) never
  // re-triggers it.
  async function requestOptions() {
    if (checkedOptions.length > 0 || isCheckingOptions) return;
    setIsCheckingOptions(true);
    try {
      const options = await apiCheckOptions(origin, destination, stops, selected.dOff, selected.rOff);
      setCheckedOptions(options);
    } finally {
      setIsCheckingOptions(false);
    }
  }

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
          value={`$${matrix[cheapestKey].total.toLocaleString()}`}
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
                    const entry = matrix[`${dOff}_${rOff}`];
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
                ${leg.price.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: "22px auto 0" }}>
        <button
          onClick={() => setShowRawData((v) => !v)}
          style={{
            background: "transparent",
            border: "1px solid #3E4650",
            color: "#C7CED6",
            borderRadius: 6,
            padding: "6px 12px",
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontWeight: 600,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          {showRawData ? "Hide raw data ▲" : "View raw data ▼"}
        </button>
        {showRawData && (
          <div
            style={{
              marginTop: 10,
              background: "#14181D",
              border: "1px solid #22282F",
              borderRadius: 10,
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: 12, color: "#7C8691", marginBottom: 10, lineHeight: 1.5 }}>
              Exactly what's currently backing this screen — the selected cell's fetched
              price/legs, the full 11×11 grid, any checked options, and the rendered
              itinerary. Cross-check these numbers against what's on screen above.
            </div>
            <pre
              className="mono"
              style={{
                margin: 0,
                fontSize: 11.5,
                lineHeight: 1.5,
                color: "#C7CED6",
                background: "#0E1216",
                border: "1px solid #22282F",
                borderRadius: 8,
                padding: "12px 14px",
                maxHeight: 480,
                overflow: "auto",
                whiteSpace: "pre",
              }}
            >
              {JSON.stringify(rawData, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div style={{ maxWidth: 980, margin: "20px auto 0", fontSize: 12, color: "#4B5560", lineHeight: 1.6 }}>
        Prices come from calculations.js, backed by mockFetcher.js's simulated SerpApi calls
        (see the technical plan) — swap that Fetcher for a real one and nothing here changes.
        The grid always prices the stop order as arranged above — one fetch per date pair,
        matching what a real fare API search would cost. Checking other city orders (or
        alternates for a round trip) is a separate, explicit action since it means pricing
        every possible ordering; once checked for a given date pair, the result is cached
        and won't be re-fetched on revisit. The dot on each cell and the "Updated Xh ago"
        line simulate a fare cache — prices go stale over time and only refresh when you
        click "Refresh price," which re-fetches just that one cell.
      </div>
    </div>
  );
}

function LoadingScreen({ origin, destination, stops, mode, error }) {
  return (
    <div
      style={{
        fontFamily: "'IBM Plex Sans', sans-serif",
        background: "#0B0E11",
        minHeight: "100vh",
        color: "#E6E9ED",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');
        .mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        @keyframes pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        @keyframes indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(220%); } }
        .pulse-dot { animation: pulse 1s ease-in-out infinite; }
        .indeterminate-fill { animation: indeterminate 1.1s ease-in-out infinite; }
      `}</style>
      <div style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
        <div
          className="mono pulse-dot"
          style={{ fontSize: 12, letterSpacing: "0.14em", color: error ? "#F87171" : "#E8A33D", textTransform: "uppercase", marginBottom: 14 }}
        >
          {error ? "Request failed" : "Fetching fares from local API server"}
        </div>
        <div style={{ fontSize: 15, color: "#C7CED6", marginBottom: 18 }}>
          {mode === "roundtrip"
            ? `${ORIGINS[origin].city} round trip`
            : `${ORIGINS[origin].city} → ${stops.map((s) => CITIES[s].city).join(" → ")} → ${ORIGINS[destination].city}`}
        </div>
        {error ? (
          <div className="mono" style={{ fontSize: 12, color: "#F87171" }}>
            {error} — is the API server running? (<code>npm run server</code>)
          </div>
        ) : (
          <>
            <div style={{ background: "#14181D", border: "1px solid #22282F", borderRadius: 8, height: 8, overflow: "hidden" }}>
              <div className="indeterminate-fill" style={{ width: "35%", height: "100%", background: "#E8A33D" }} />
            </div>
            <div className="mono" style={{ fontSize: 12, color: "#7C8691", marginTop: 10 }}>
              GET /api/fare-grid — ~121 cache-through lookups server-side
            </div>
          </>
        )}
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