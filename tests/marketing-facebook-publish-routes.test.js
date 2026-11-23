/**
 * @file marketing-facebook-publish-routes.test.js
 * @description KAN-91 route guards for publishing a vehicle post to the Facebook Page.
 *
 * The important case is the last one: with no Page credentials in the environment the
 * REAL service must answer 503 FACEBOOK_NOT_CONFIGURED and list the missing variables.
 * Nothing is simulated — a test that "publishes successfully" without a token would be
 * exactly the fake this ticket forbids.
 */

import express from 'express';
import request from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();

const url = '/api/v1/marketing/facebook/publish';
const carId = '65f000000000000000000042';

const { default: marketingRoutes } = await import('../src/routes/marketingRoutes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorMiddleware.js');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { getFacebookConfig } = await import('../src/config/facebook.js');
const { facebookPermalink } = await import('../src/services/facebookPublishService.js');

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
  const req = request(app).post(url);
  if (auth) req.set('Authorization', auth);
  return req.send(body);
};

beforeEach(() => {
  h.reset();
  // Mỗi test bắt đầu ở trạng thái "chưa cấu hình Facebook".
  delete process.env.FACEBOOK_PAGE_ID;
  delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  delete process.env.FACEBOOK_GRAPH_VERSION;
});

describe('POST /api/v1/marketing/facebook/publish', () => {
  test('không có token → 401', async () => {
    const res = await post({ carId, caption: 'Xe đẹp' });

    expect(res.status).toBe(401);
  });

  test.each(['SALES_STAFF', 'CUSTOMER'])('%s bị từ chối 403 (chỉ ADMIN)', async (role) => {
    const user = await tokenFor(role);

    const res = await post({ carId, caption: 'Xe đẹp' }, user.auth);

    expect(res.status).toBe(403);
  });

  test.each([
    ['thiếu caption', { carId }],
    ['caption rỗng', { carId, caption: '   ' }],
    ['thiếu carId', { caption: 'Xe đẹp' }],
    ['imageUrl không phải http(s)', { carId, caption: 'Xe đẹp', imageUrl: 'javascript:alert(1)' }],
  ])('%s → 422 VALIDATION_ERROR', async (_label, body) => {
    const user = await tokenFor('ADMIN');

    const res = await post(body, user.auth);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('chưa cấu hình Page → 503 FACEBOOK_NOT_CONFIGURED kèm biến còn thiếu (không giả lập đăng)', async () => {
    const user = await tokenFor('ADMIN');

    const res = await post({ carId, caption: 'Xe đẹp, giá tốt' }, user.auth);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, code: 'FACEBOOK_NOT_CONFIGURED' });
    expect(res.body.errors.map((item) => item.field).sort()).toEqual([
      'FACEBOOK_PAGE_ACCESS_TOKEN',
      'FACEBOOK_PAGE_ID',
    ]);
    // Không có postId nào được bịa ra.
    expect(res.body.data).toBeUndefined();
  });

  test('thiếu mỗi token cũng bị chặn và chỉ rõ biến thiếu', async () => {
    process.env.FACEBOOK_PAGE_ID = '1234567890';
    const user = await tokenFor('ADMIN');

    const res = await post({ carId, caption: 'Xe đẹp' }, user.auth);

    expect(res.status).toBe(503);
    expect(res.body.errors).toEqual([
      expect.objectContaining({ field: 'FACEBOOK_PAGE_ACCESS_TOKEN' }),
    ]);
  });
});

describe('getFacebookConfig', () => {
  test('thiếu cả hai biến → chưa cấu hình, liệt kê đủ', () => {
    expect(getFacebookConfig({})).toMatchObject({
      configured: false,
      missing: ['FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_ACCESS_TOKEN'],
      graphVersion: 'v24.0',
    });
  });

  test('đủ biến → đã cấu hình, cắt khoảng trắng', () => {
    const config = getFacebookConfig({
      FACEBOOK_PAGE_ID: ' 1234567890 ',
      FACEBOOK_PAGE_ACCESS_TOKEN: ' EAAG... ',
      FACEBOOK_GRAPH_VERSION: 'v20.0',
    });

    expect(config).toMatchObject({
      configured: true,
      pageId: '1234567890',
      accessToken: 'EAAG...',
      graphVersion: 'v20.0',
      missing: [],
    });
  });

  test('phiên bản Graph sai định dạng → quay về mặc định', () => {
    expect(getFacebookConfig({
      FACEBOOK_PAGE_ID: '1',
      FACEBOOK_PAGE_ACCESS_TOKEN: 't',
      FACEBOOK_GRAPH_VERSION: 'latest',
    }).graphVersion).toBe('v24.0');
  });
});

describe('facebookPermalink', () => {
  test('ghép link từ post_id dạng pageId_postId', () => {
    expect(facebookPermalink('1234567890_9876543210', '1234567890'))
      .toBe('https://www.facebook.com/1234567890/posts/9876543210');
  });

  test('post_id không có dấu _ thì dùng pageId đã cấu hình', () => {
    expect(facebookPermalink('9876543210', '1234567890'))
      .toBe('https://www.facebook.com/1234567890/posts/9876543210');
  });

  test('thiếu postId → null', () => {
    expect(facebookPermalink('', '1234567890')).toBeNull();
    expect(facebookPermalink(null, '1234567890')).toBeNull();
  });
});
