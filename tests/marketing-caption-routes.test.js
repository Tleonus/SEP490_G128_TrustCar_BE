/**
 * @file marketing-caption-routes.test.js
 * @description KAN-68 route guards: who may call the endpoint and what bodies pass
 * validation. Business behaviour is covered in caption.test.js; this file mounts
 * the real router with the auth harness so the middleware order is exercised.
 */

import express from 'express';
import request from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';
import { captionServiceMock } from './helpers/fakeCaptionService.js';

const h = await setupAuthHarness();

const carId = '65f000000000000000000042';
const generate = captionServiceMock.generateCaptions;

const { default: marketingRoutes } = await import('../src/routes/marketingRoutes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorMiddleware.js');
const { signAccessToken } = await import('../src/utils/authTokens.js');

/** Creates a user with `role` and returns their access token. */
const tokenFor = async (roleName) => {
  const { id } = await h.createUser({ roleName });
  const user = await h.User.findById(id).select('+tokenVersion');
  return { id, auth: `Bearer ${signAccessToken(user)}` };
};

const app = express();
app.use(express.json());
app.use('/api/v1/marketing', marketingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const post = (body, auth) => {
  const req = request(app).post('/api/v1/marketing/caption');
  if (auth) req.set('Authorization', auth);
  return req.send(body);
};

beforeEach(() => {
  h.reset();
  generate.mockClear();
});

describe('POST /api/v1/marketing/caption', () => {
  test('no token → 401', async () => {
    const res = await post({ carId });

    expect(res.status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });

  test.each(['ADMIN', 'SALES_STAFF'])('%s may generate captions', async (role) => {
    const user = await tokenFor(role);

    const res = await post({ carId, tone: 'friendly' }, user.auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { captions: ['option 1', 'option 2', 'option 3'] } });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ carId, tone: 'friendly', userId: user.id }));
  });

  test.each(['CUSTOMER'])('%s is rejected with 403', async (role) => {
    const user = await tokenFor(role);

    const res = await post({ carId }, user.auth);

    expect(res.status).toBe(403);
    expect(generate).not.toHaveBeenCalled();
  });

  test('missing carId → 422', async () => {
    const user = await tokenFor('SALES_STAFF');

    const res = await post({ tone: 'friendly' }, user.auth);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('unknown tone → 422', async () => {
    const user = await tokenFor('SALES_STAFF');

    const res = await post({ carId, tone: 'sarcastic' }, user.auth);

    expect(res.status).toBe(422);
    expect(res.body.errors.some((e) => e.field === 'tone')).toBe(true);
  });

  test('defaults are applied before the service is called', async () => {
    const user = await tokenFor('SALES_STAFF');

    await post({ carId }, user.auth);

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'professional', platform: 'facebook', length: 'medium',
    }));
  });

  test('a service error is reported with its own status and code', async () => {
    const user = await tokenFor('SALES_STAFF');
    const { AppError } = await import('../src/utils/apiResponse.js');
    generate.mockRejectedValueOnce(new AppError('Vehicle not found.', 404, 'CAR_NOT_FOUND'));

    const res = await post({ carId }, user.auth);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CAR_NOT_FOUND');
  });
});
