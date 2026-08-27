// server/dedupe.js
//
// In-flight request coalescing (plan §4). If two callers ask for the same cache
// key while a fetch for it is already running — e.g. two grid cells or two
// browser tabs hitting the same date pair on first load — both get the same
// promise instead of firing a second real Fetcher call.

const inFlight = new Map();

export function dedupe(key, fn) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** Test-only: how many keys currently have a request in flight. */
export function _inFlightCountForTests() {
  return inFlight.size;
}
