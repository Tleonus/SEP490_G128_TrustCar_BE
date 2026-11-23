/**
 * @file loginAttemptTracker.js
 * @description KAN-101 — in-memory counter for failed login attempts, keyed by
 * email + IP. Reaches threshold → caller must auto-lock the user account.
 *
 * Separate from `rateLimiters.js` because that file uses `express-rate-limit`
 * (returns 429s at the middleware level), whereas KAN-101 needs to run _inside_
 * the login service so a count can trigger a database write (lockedUntil).
 *
 * Counters live in this process only: a restart resets them. That is acceptable
 * — the goal is to slow down a single bursty attacker, not to be a cluster-wide
 * brute-force shield (we have the global auth limiter for that).
 */

const WINDOW_MS = 15 * 60 * 1000;         // 15-minute sliding window
const DEFAULT_THRESHOLD = 5;              // 5 failures → lock

/** Key is case-folded email + raw IP. */
const keyOf = (email, ip) => `${String(email || '').toLowerCase()}|${ip || '-'}`;

const attempts = new Map(); // key → { count, firstAt }

/**
 * Removes stale entries (older than WINDOW_MS). Called on each access so the
 * map cannot grow without bound.
 */
const prune = (now) => {
  for (const [k, v] of attempts) {
    if (now - v.firstAt > WINDOW_MS) attempts.delete(k);
  }
};

/**
 * Records one failed attempt and returns the running state.
 * @param {object} params
 * @param {string} params.email
 * @param {string} [params.ip]
 * @param {number} [params.threshold] — default 5
 * @returns {{ count: number, exceeded: boolean, threshold: number, windowMs: number }}
 */
export const recordLoginFailure = ({ email, ip, threshold = DEFAULT_THRESHOLD }) => {
  const now = Date.now();
  prune(now);

  const key = keyOf(email, ip);
  const prev = attempts.get(key);
  const next = prev && (now - prev.firstAt <= WINDOW_MS)
    ? { count: prev.count + 1, firstAt: prev.firstAt }
    : { count: 1, firstAt: now };

  attempts.set(key, next);
  return {
    count:     next.count,
    exceeded:  next.count >= threshold,
    threshold,
    windowMs:  WINDOW_MS,
  };
};

/** Resets the counter for this (email, ip) — call on successful login. */
export const resetLoginFailures = ({ email, ip }) => {
  attempts.delete(keyOf(email, ip));
};

/** Test-only — wipe all counters so suites do not leak state. */
export const __resetAllLoginFailuresForTests = () => attempts.clear();

/** Test-only — how many entries we are holding (helps assert prune behaviour). */
export const __loginFailureCount = () => attempts.size;

export const LOGIN_FAILURE_WINDOW_MS = WINDOW_MS;
export const LOGIN_FAILURE_THRESHOLD = DEFAULT_THRESHOLD;
