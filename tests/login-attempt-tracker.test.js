/**
 * @file login-attempt-tracker.test.js
 * @description KAN-101 — unit tests for the in-memory failure counter that
 * backs the auto-lock behaviour in authService.
 */

import { jest } from '@jest/globals';
import {
  recordLoginFailure,
  resetLoginFailures,
  __resetAllLoginFailuresForTests,
  __loginFailureCount,
  LOGIN_FAILURE_THRESHOLD,
  LOGIN_FAILURE_WINDOW_MS,
} from '../src/services/loginAttemptTracker.js';

beforeEach(() => __resetAllLoginFailuresForTests());

describe('loginAttemptTracker', () => {
  test('first failure returns count 1 and not exceeded', () => {
    const state = recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    expect(state.count).toBe(1);
    expect(state.exceeded).toBe(false);
    expect(state.threshold).toBe(LOGIN_FAILURE_THRESHOLD);
  });

  test('fifth failure flips exceeded=true', () => {
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    }
    expect(last.count).toBe(5);
    expect(last.exceeded).toBe(true);
  });

  test('different IPs are counted separately', () => {
    recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    const other = recordLoginFailure({ email: 'a@x.vn', ip: '2.2.2.2' });
    expect(other.count).toBe(1);
    expect(other.exceeded).toBe(false);
  });

  test('email is case-folded so Alice@X.vn and alice@x.vn share a counter', () => {
    recordLoginFailure({ email: 'Alice@X.vn', ip: '1.1.1.1' });
    const s = recordLoginFailure({ email: 'alice@x.vn', ip: '1.1.1.1' });
    expect(s.count).toBe(2);
  });

  test('resetLoginFailures wipes just that key', () => {
    recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    recordLoginFailure({ email: 'b@x.vn', ip: '1.1.1.1' });
    resetLoginFailures({ email: 'a@x.vn', ip: '1.1.1.1' });
    expect(__loginFailureCount()).toBe(1);
  });

  test('after a successful reset the next failure starts from 1 again', () => {
    recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    resetLoginFailures({ email: 'a@x.vn', ip: '1.1.1.1' });
    const s = recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    expect(s.count).toBe(1);
    expect(s.exceeded).toBe(false);
  });

  test('entries older than the window are pruned on next access', () => {
    jest.useFakeTimers({ now: new Date('2026-11-22T00:00:00Z') });
    recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1' });
    expect(__loginFailureCount()).toBe(1);

    // Advance past the sliding window.
    jest.setSystemTime(new Date(Date.now() + LOGIN_FAILURE_WINDOW_MS + 1000));
    // The next write for a different key triggers prune(); the stale entry must go.
    recordLoginFailure({ email: 'b@x.vn', ip: '9.9.9.9' });
    expect(__loginFailureCount()).toBe(1);
    jest.useRealTimers();
  });

  test('threshold is overridable per call', () => {
    const s1 = recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1', threshold: 2 });
    expect(s1.exceeded).toBe(false);
    const s2 = recordLoginFailure({ email: 'a@x.vn', ip: '1.1.1.1', threshold: 2 });
    expect(s2.count).toBe(2);
    expect(s2.exceeded).toBe(true);
  });
});
