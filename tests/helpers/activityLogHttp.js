/**
 * @file activityLogHttp.js
 * @description Shared setup of the KAN-40 HTTP tests: the real Express app on the in-memory auth
 * harness plus the in-memory ActivityLog stand-in. Must be awaited at the top level of a test file,
 * before anything else from src/ is imported (same rule as `setupAuthHarness`).
 */

import { default as request } from 'supertest';
import { setupAuthHarness } from './fakeAuthModels.js';

export const API = '/api/v1/admin/activity-logs';

export const setupActivityLogHttp = async () => {
  const h = await setupAuthHarness();
  const { default: ActivityLog } = await import('../../src/models/ActivityLog.js');
  const { setupActivityLogFake } = await import('./fakeActivityLogModel.js');
  const { signAccessToken } = await import('../../src/utils/authTokens.js');
  const fake = await setupActivityLogFake(ActivityLog);

  let phone = 0;
  const tokenFor = async (roleName) => {
    phone += 1;
    const { id } = await h.createUser({ roleName, phone: `09012345${String(phone).padStart(2, '0')}` });
    return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
  };

  /** Each request gets its own client IP so the rate limiter never interferes. */
  const send = (method, url, token, body) => {
    const req = request(h.app)[method](url).set('X-Forwarded-For', h.nextIp());
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };

  const reset = () => { h.reset(); fake.reset(); };
  return { h, fake, tokenFor, send, reset };
};

export default { setupActivityLogHttp, API };
