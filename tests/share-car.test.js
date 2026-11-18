/**
 * @file share-car.test.js
 * @description KAN-64: share preview data and the OG markup crawlers read.
 *
 * The route itself is exercised indirectly: renderSharePage only looks up the
 * preview and sends this markup, and importing app.js pulls firebase-admin,
 * which Jest cannot load (see health.test.js, which builds its own mini app
 * for the same reason).
 */

import { jest } from '@jest/globals';

const findOne = jest.fn();

jest.unstable_mockModule('../src/models/Car.js', () => ({
  default: { findOne: (...args) => findOne(...args) },
}));

const { getSharePreview, sharePageUrl } = await import('../src/services/shareCarService.js');
const { renderPreview, renderSharePage } = await import('../src/controllers/shareCarController.js');

const chain = (car) => ({ lean: async () => car });

const availableCar = {
  vehicleCode: 'TC-2026-0001',
  make: 'TOYOTA',
  model: 'Vios',
  variant: 'G',
  year: 2022,
  price: 520_000_000,
  mileage: 35000,
  transmission: 'AUTOMATIC',
  fuelType: 'GASOLINE',
  cpoCertificateId: 'CPO-2026-0009',
  images: [
    { url: 'https://cdn.example.com/side.jpg', isPrimary: false },
    { url: 'https://cdn.example.com/front.jpg', isPrimary: true },
  ],
};

const html = (preview) => renderPreview(preview);

beforeEach(() => {
  findOne.mockReset();
  delete process.env.SHARE_BASE_URL;
  delete process.env.FRONTEND_URL;
});

test('builds the title, description and primary image', async () => {
  findOne.mockReturnValue(chain(availableCar));

  const preview = await getSharePreview('TC-2026-0001');

  expect(preview.title).toBe('TOYOTA Vios G 2022 520 triệu');
  expect(preview.description).toBe('35.000 km · số tự động · xăng · CPO CPO-2026-0009');
  expect(preview.image).toBe('https://cdn.example.com/front.jpg');
  expect(preview.redirectUrl).toBe('http://localhost:5173/xe/TC-2026-0001');
  expect(findOne.mock.calls[0][0]).toMatchObject({ vehicleCode: 'TC-2026-0001', status: 'AVAILABLE', isActive: true });
});

test('renders every OG tag the crawler needs', async () => {
  findOne.mockReturnValue(chain(availableCar));
  const preview = await getSharePreview('TC-2026-0001');
  preview.shareUrl = sharePageUrl(preview.vehicleCode);

  const page = html(preview);

  expect(page).toContain('<meta property="og:title" content="TOYOTA Vios G 2022 520 triệu">');
  expect(page).toContain('og:description" content="35.000 km · số tự động · xăng · CPO CPO-2026-0009"');
  expect(page).toContain('og:image" content="https://cdn.example.com/front.jpg"');
  expect(page).toContain('<meta property="og:image:width" content="1200">');
  expect(page).toContain('<meta property="og:type" content="product">');
  expect(page).toContain('<meta name="twitter:card" content="summary_large_image">');
  expect(page).toContain('content="0;url=http://localhost:5173/xe/TC-2026-0001"');
  expect(page).toContain('location.replace("http://localhost:5173/xe/TC-2026-0001")');
});

test('prefers socialImage and never leaks its publicId', async () => {
  findOne.mockReturnValue(chain({
    ...availableCar,
    socialImage: { url: 'https://cdn.example.com/social.jpg', publicId: 'secret-id' },
  }));

  const preview = await getSharePreview('tc-2026-0001');

  expect(preview.image).toBe('https://cdn.example.com/social.jpg');
  expect(html(preview)).not.toContain('secret-id');
});

test('escapes vehicle data inside the markup', async () => {
  findOne.mockReturnValue(chain({ ...availableCar, model: 'Vios"><script>' }));

  const page = html(await getSharePreview('TC-2026-0001'));

  expect(page).not.toContain('"><script>');
  expect(page).toContain('Vios&quot;&gt;&lt;script&gt;');
});

test('formats prices at and above one billion', async () => {
  findOne.mockReturnValue(chain({ ...availableCar, price: 1_250_000_000 }));

  const preview = await getSharePreview('TC-2026-0001');

  expect(preview.title).toContain('1,25 tỷ');
});

test('rejects an unavailable car and a malformed code', async () => {
  findOne.mockReturnValue(chain(null));
  await expect(getSharePreview('TC-2026-9999')).rejects.toMatchObject({ statusCode: 404 });

  await expect(getSharePreview('not-a-code')).rejects.toMatchObject({ statusCode: 404 });
  expect(findOne).toHaveBeenCalledTimes(1);
});

test('uses SHARE_BASE_URL for og:url when configured', () => {
  process.env.SHARE_BASE_URL = 'https://api.trustcar.vn/';

  expect(sharePageUrl('TC-2026-0001', { protocol: 'http', get: () => 'localhost:5000' }))
    .toBe('https://api.trustcar.vn/share/car/TC-2026-0001');
});

test('the handler sends the markup and an unavailable page on 404', async () => {
  findOne.mockReturnValue(chain(availableCar));
  const res = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(), send: jest.fn() };

  await renderSharePage({ params: { code: 'TC-2026-0001' }, protocol: 'https', get: () => 'api.trustcar.vn' }, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.type).toHaveBeenCalledWith('html');
  expect(res.send.mock.calls[0][0]).toContain('og:url" content="https://api.trustcar.vn/share/car/TC-2026-0001"');

  findOne.mockReturnValue(chain(null));
  await renderSharePage({ params: { code: 'TC-2026-0002' } }, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.send.mock.calls[1][0]).toContain('không còn');
  expect(res.send.mock.calls[1][0]).not.toContain('og:title');
});
