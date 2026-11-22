import express from 'express';
import request from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { jest } = await import('@jest/globals');
const { AppError, sendError, WISHLIST_ERROR_CONTRACT } = await import('../src/utils/apiResponse.js');
const { errorHandler } = await import('../src/middlewares/errorMiddleware.js');
const { createGlobalLimiter, identifyCaller, markWishlistErrorContract } = await import('../src/middlewares/rateLimiters.js');
const { SystemMessages: MSG } = await import('../src/constants/systemMessages.js');
const PREVIEW = '/api/v1/public/wishlist/preview';
const PRIVATE_INPUT = 'private-input-sentinel';
const originalEnvironment = process.env.NODE_ENV;

const assertMetadata = (res, code) => {
  expect(res.body).toMatchObject({ success: false, code, error_code: code });
  expect(res.body.request_id).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
  expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  expect(res.body).not.toHaveProperty('stack');
};

const errorApp = (error, { direct = false, wishlist = true } = {}) => {
  const app = express();
  app.use((_req, res, next) => {
    if (wishlist) res.locals.errorContract = WISHLIST_ERROR_CONTRACT;
    next();
  });
  app.get('/', (_req, res, next) => {
    if (direct) return sendError(res, error.statusCode, error.message, error.code, error.errors);
    next(error);
  });
  app.use(errorHandler);
  return app;
};

afterEach(() => {
  process.env.NODE_ENV = originalEnvironment;
  jest.restoreAllMocks();
});

test('real Wishlist auth failures include ENG-02 metadata before authentication', async () => {
  const res = await request(h.app).get('/api/v1/customer/wishlist');
  expect(res.status).toBe(401);
  assertMetadata(res, 'TOKEN_MISSING');
});

test('real guest Joi validation retains safe legacy errors and adds metadata', async () => {
  const res = await request(h.app).get(PREVIEW).query({ ids: PRIVATE_INPUT });
  expect(res.status).toBe(422);
  assertMetadata(res, 'VALIDATION_ERROR');
  expect(res.body.errors).toEqual([{ field: 'ids', message: 'Invalid value for this field.' }]);
  expect(JSON.stringify(res.body)).not.toContain(PRIVATE_INPUT);
});

test('malformed JSON on a Wishlist path gets ENG-02 metadata before the router', async () => {
  const res = await request(h.app)
    .post(PREVIEW)
    .set('X-Forwarded-For', h.nextIp())
    .set('Content-Type', 'application/json')
    .send(`{"ids":"${PRIVATE_INPUT}"`);

  expect(res.status).toBe(400);
  assertMetadata(res, 'INVALID_REQUEST');
  expect(res.body.message).toBe(MSG.MSG67.message);
  expect(res.body).not.toHaveProperty('errors');
  expect(JSON.stringify(res.body)).not.toContain(PRIVATE_INPUT);
});

test('global limiter keeps Wishlist-only metadata and the legacy envelope for other paths', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(markWishlistErrorContract);
  app.use('/api/', identifyCaller, createGlobalLimiter({ ip: 1, customer: 1, staff: 1 }));
  app.use(express.json());
  app.get('/api/v1/public/wishlist/preview', (_req, res) => res.json({ success: true }));
  app.get('/api/v1/health', (_req, res) => res.json({ success: true }));

  const clientIp = h.nextIp();
  const wishlistRequest = () => request(app)
    .get(PREVIEW)
    .set('X-Forwarded-For', clientIp);

  await wishlistRequest().expect(200);
  const wishlistLimited = await wishlistRequest().expect(429);
  assertMetadata(wishlistLimited, 'RATE_LIMIT_EXCEEDED');
  expect(wishlistLimited.body.message).toBe(MSG.MSG64.message);
  expect(wishlistLimited.headers['ratelimit-limit']).toBe('1');
  expect(wishlistLimited.headers['ratelimit-remaining']).toBe('0');
  expect(wishlistLimited.headers).toHaveProperty('retry-after');

  const otherLimited = await request(app)
    .get('/api/v1/health')
    .set('X-Forwarded-For', clientIp)
    .expect(429);
  expect(otherLimited.body).toEqual({
    success: false,
    message: 'Too many requests. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  });
  expect(otherLimited.headers['ratelimit-limit']).toBe('1');
  expect(otherLimited.headers['ratelimit-remaining']).toBe('0');
  expect(otherLimited.headers).toHaveProperty('retry-after');

  await request(app)
    .get('/api/v1/health')
    .set('X-Forwarded-For', h.nextIp())
    .expect(200);
});

test('each request gets a fresh server ID regardless of an inbound ID', async () => {
  const first = await request(h.app).get(PREVIEW).query({ ids: 'bad' }).set('X-Request-ID', PRIVATE_INPUT);
  const second = await request(h.app).get(PREVIEW).query({ ids: 'bad' }).set('X-Request-ID', PRIVATE_INPUT);
  assertMetadata(first, 'VALIDATION_ERROR');
  assertMetadata(second, 'VALIDATION_ERROR');
  expect(first.body.request_id).not.toBe(PRIVATE_INPUT);
  expect(first.body.request_id).not.toBe(second.body.request_id);
});

test.each(['development', 'production'])('unexpected Wishlist errors stay safe in %s', async (environment) => {
  process.env.NODE_ENV = environment;
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const res = await request(errorApp(new Error(PRIVATE_INPUT))).get('/');
  expect(res.status).toBe(500);
  assertMetadata(res, 'INTERNAL_ERROR');
  expect(res.body.message).toBe(MSG.MSG62.message);
  expect(JSON.stringify(res.body)).not.toContain(PRIVATE_INPUT);
  expect(log).toHaveBeenCalledWith('[Wishlist error]', {
    request_id: res.body.request_id, statusCode: 500, code: 'INTERNAL_ERROR',
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE_INPUT);
});

test('driver duplicate-key values never appear in the Wishlist response', async () => {
  const error = Object.assign(new Error(PRIVATE_INPUT), { code: 11000, keyValue: { email: PRIVATE_INPUT } });
  const res = await request(errorApp(error)).get('/');
  expect(res.status).toBe(409);
  assertMetadata(res, 'DUPLICATE_KEY');
  expect(res.body.message).toBe(MSG.MSG66.message);
  expect(JSON.stringify(res.body)).not.toContain(PRIVATE_INPUT);
});

test('driver validation metadata allow-lists field names and removes values', async () => {
  const error = Object.assign(new Error(PRIVATE_INPUT), {
    name: 'ValidationError', errors: {
      carId: { path: 'carId', message: PRIVATE_INPUT },
      private: { path: PRIVATE_INPUT, message: PRIVATE_INPUT },
    },
  });
  const res = await request(errorApp(error)).get('/');
  assertMetadata(res, 'VALIDATION_ERROR');
  expect(res.body.errors).toEqual([
    { field: 'carId', message: 'Invalid value for this field.' },
    { field: 'unknown', message: 'Invalid value for this field.' },
  ]);
  expect(JSON.stringify(res.body)).not.toContain(PRIVATE_INPUT);
});

test('direct helper also sanitizes a Wishlist 500 and its details', async () => {
  const error = new AppError(PRIVATE_INPUT, 500, 'INTERNAL_ERROR', [{ field: PRIVATE_INPUT }]);
  const res = await request(errorApp(error, { direct: true })).get('/');
  assertMetadata(res, 'INTERNAL_ERROR');
  expect(res.body.message).toBe(MSG.MSG62.message);
  expect(JSON.stringify(res.body)).not.toContain(PRIVATE_INPUT);
});

test('Wishlist not-found response omits path/query values', async () => {
  const res = await request(h.app).get(`/api/v1/public/wishlist/${PRIVATE_INPUT}?value=${PRIVATE_INPUT}`);
  expect(res.status).toBe(404);
  assertMetadata(res, 'NOT_FOUND');
  expect(res.body.message).toBe(MSG.MSG61.message);
  expect(JSON.stringify(res.body)).not.toContain(PRIVATE_INPUT);
});

test('an unmarked API keeps the exact legacy shape through both error paths', async () => {
  const error = new AppError('Expected public message.', 422, 'VALIDATION_ERROR', [{ field: 'id', message: 'Required.' }]);
  for (const direct of [false, true]) {
    const res = await request(errorApp(error, { direct, wishlist: false })).get('/');
    expect(res.body).toEqual({ success: false, message: error.message, code: error.code, errors: error.errors });
  }
  const auth = await request(h.app).get('/api/v1/auth/me');
  expect(auth.status).toBe(401);
  expect(auth.body).toEqual({ success: false, message: MSG.MSG01.message, code: MSG.MSG01.code });
});

test('successful Wishlist responses do not acquire error metadata', async () => {
  const res = await request(h.app).get(PREVIEW);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body).not.toHaveProperty('error_code');
  expect(res.body).not.toHaveProperty('request_id');
  expect(res.body).not.toHaveProperty('timestamp');
});
