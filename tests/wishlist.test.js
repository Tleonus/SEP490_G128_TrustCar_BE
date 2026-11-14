/**
 * @file wishlist.test.js
 * @description Comprehensive unit & integration tests for Saved Cars Wishlist,
 * Guest localStorage Preview + Sync, and Automated Price Drop Alerts.
 *
 * Runs the real Express app on the in-memory auth harness (no live MongoDB connection).
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { jest } = await import('@jest/globals');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { default: Car } = await import('../src/models/Car.js');
const { default: SavedCar } = await import('../src/models/SavedCar.js');
const { default: PriceHistory } = await import('../src/models/PriceHistory.js');
const { notifyPriceDropForCar, MAX_WISHLIST_ITEMS } = await import('../src/services/wishlistService.js');
const { WISHLIST_CAR_PROJECTION } = await import('../src/repositories/wishlistRepository.js');

const oid = () => new mongoose.Types.ObjectId().toString();

// ── In-memory stores for Car, SavedCar, PriceHistory ────────────────────────
let carStore = new Map();
let savedStore = new Map();
let priceHistoryStore = new Map();
let carQueryCalls = 0;

const makeCar = (overrides = {}) => {
  const _id = overrides._id || oid();
  return {
    _id,
    vehicleCode: `TC-2026-${String(carStore.size + 1).padStart(4, '0')}`,
    make: 'TOYOTA',
    model: 'Corolla Cross',
    variant: '1.8HV',
    year: 2023,
    bodyType: 'SUV',
    fuelType: 'HYBRID',
    transmission: 'CVT',
    driveType: 'FWD',
    mileage: 18000,
    price: 780000000,
    ownerType: 'INDIVIDUAL',
    conditionGrade: 'A',
    cpoCertificateId: `CPO-${_id.slice(-6)}`,
    status: 'AVAILABLE',
    isActive: true,
    // Internal sentinel fields that MUST NEVER leak to customers
    vin: 'SENTINEL-VIN-00001',
    licensePlate: 'SENTINEL-PLATE',
    floorPrice: 700000000,
    originalPrice: 820000000,
    listedPrice: 780000000,
    internalNotes: 'SENTINEL-INTERNAL-NOTE',
    priceHistory: [{ price: 800000000, reason: 'SENTINEL-HISTORY' }],
    createdBy: oid(),
    updatedBy: oid(),
    statusChangedBy: oid(),
    images: [
      { url: 'https://cdn.trustcar.vn/1.jpg', publicId: 'SENTINEL-PUB-1', isPrimary: false },
      { url: 'https://cdn.trustcar.vn/primary.jpg', publicId: 'SENTINEL-PUB-2', isPrimary: true },
    ],
    ...overrides,
  };
};

const putCar = (overrides = {}) => {
  const car = makeCar(overrides);
  carStore.set(String(car._id), car);
  return car;
};

// Fake query builder that deliberately ignores projections so DTO leak assertions prove allow-list mapping
const chainable = (resolver) => {
  let skipVal = 0;
  let limitVal = null;
  let sortSpec = null;

  const q = {
    select: () => q,
    populate: () => q,
    sort: (spec) => {
      sortSpec = spec;
      return q;
    },
    skip: (n) => {
      skipVal = n;
      return q;
    },
    limit: (n) => {
      limitVal = n;
      return q;
    },
    lean: () => q,
    then: (onFulfilled, onRejected) =>
      Promise.resolve()
        .then(() => {
          let result = resolver();
          if (Array.isArray(result)) {
            let arr = [...result];
            if (sortSpec) {
              arr.sort((a, b) => {
                for (const [key, dir] of Object.entries(sortSpec)) {
                  const av = key === 'createdAt' ? new Date(a[key]).getTime() : String(a[key]);
                  const bv = key === 'createdAt' ? new Date(b[key]).getTime() : String(b[key]);
                  if (av < bv) return dir === -1 ? 1 : -1;
                  if (av > bv) return dir === -1 ? -1 : 1;
                }
                return 0;
              });
            }
            if (skipVal > 0) arr = arr.slice(skipVal);
            if (limitVal !== null) arr = arr.slice(0, limitVal);
            return arr;
          }
          return result;
        })
        .then(onFulfilled, onRejected),
  };
  return q;
};

// ── Wire mocks for Car, SavedCar, User.find, and PriceHistory ───────────────

jest.spyOn(Car, 'findOne').mockImplementation((filter) => {
  carQueryCalls += 1;
  return chainable(() => {
    const c = carStore.get(String(filter._id));
    if (!c) return null;
    if (filter.status && c.status !== filter.status) return null;
    if (filter.isActive !== undefined && c.isActive !== filter.isActive) return null;
    return { ...c };
  });
});

jest.spyOn(Car, 'findById').mockImplementation((id) => {
  carQueryCalls += 1;
  return chainable(() => {
    const c = carStore.get(String(id));
    return c ? { ...c } : null;
  });
});

jest.spyOn(Car, 'find').mockImplementation((filter) => {
  carQueryCalls += 1;
  return chainable(() => {
    const wanted = filter?._id?.$in ? new Set(filter._id.$in.map(String)) : null;
    return [...carStore.values()]
      .filter((c) => {
        if (wanted && !wanted.has(String(c._id))) return false;
        if (filter.status && c.status !== filter.status) return false;
        if (filter.isActive !== undefined && c.isActive !== filter.isActive) return false;
        return true;
      })
      .reverse() // Reverse to verify order restoration in Guest preview & Sync
      .map((c) => ({ ...c }));
  });
});

jest.spyOn(h.User, 'find').mockImplementation((filter = {}) =>
  chainable(() => {
    const wanted = filter?._id?.$in ? new Set(filter._id.$in.map(String)) : null;
    return [...h.users.values()]
      .filter((u) => {
        if (wanted && !wanted.has(String(u._id))) return false;
        if (filter.isActive !== undefined && u.isActive !== filter.isActive) return false;
        if (filter.roleName && u.roleName !== filter.roleName) return false;
        return true;
      })
      .map((u) => ({ _id: u._id, fullName: u.fullName, email: u.email }));
  })
);

const cloneSaved = (raw) => ({
  ...raw,
  priceAlerts: (raw.priceAlerts || []).map((a) => ({ ...a })),
});

const matchSaved = (doc, filter = {}) => {
  if (filter._id && String(doc._id) !== String(filter._id)) return false;
  if (filter.user && String(doc.user) !== String(filter.user)) return false;
  if (filter.car) {
    if (filter.car.$in) {
      const set = new Set(filter.car.$in.map(String));
      if (!set.has(String(doc.car))) return false;
    } else if (String(doc.car) !== String(filter.car)) {
      return false;
    }
  }
  if (filter.priceAlertEnabled !== undefined && doc.priceAlertEnabled !== filter.priceAlertEnabled) {
    return false;
  }
  if (filter['priceAlerts._id']) {
    const targetAlertId = String(filter['priceAlerts._id']);
    if (!(doc.priceAlerts || []).some((a) => String(a._id) === targetAlertId)) return false;
  }
  return true;
};

const hydrateSavedDoc = (raw) => {
  const doc = SavedCar.hydrate(cloneSaved(raw));
  doc.save = async function saveHydrated() {
    await this.validate();
    const plain = this.toObject();
    plain.updatedAt = new Date();
    savedStore.set(String(plain._id), cloneSaved(plain));
    return this;
  };
  return doc;
};

jest.spyOn(SavedCar, 'countDocuments').mockImplementation(async (filter = {}) =>
  [...savedStore.values()].filter((d) => matchSaved(d, filter)).length
);

jest.spyOn(SavedCar, 'findOne').mockImplementation((filter = {}) => {
  let useLean = false;
  const q = {
    lean: () => {
      useLean = true;
      return q;
    },
    then: (ok, ko) =>
      Promise.resolve()
        .then(() => {
          const found = [...savedStore.values()].find((d) => matchSaved(d, filter)) || null;
          if (!found) return null;
          return useLean ? cloneSaved(found) : hydrateSavedDoc(found);
        })
        .then(ok, ko),
  };
  return q;
});

jest.spyOn(SavedCar, 'find').mockImplementation((filter = {}) => {
  let useLean = false;
  let sortSpec = null;
  let skipVal = 0;
  let limitVal = null;

  const q = {
    sort: (s) => {
      sortSpec = s;
      return q;
    },
    skip: (n) => {
      skipVal = n;
      return q;
    },
    limit: (n) => {
      limitVal = n;
      return q;
    },
    lean: () => {
      useLean = true;
      return q;
    },
    then: (ok, ko) =>
      Promise.resolve()
        .then(() => {
          let list = [...savedStore.values()].filter((d) => matchSaved(d, filter));
          if (sortSpec) {
            list.sort((a, b) => {
              const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
              if (diff !== 0) return diff;
              return String(b._id).localeCompare(String(a._id));
            });
          }
          if (skipVal > 0) list = list.slice(skipVal);
          if (limitVal !== null) list = list.slice(0, limitVal);
          return list.map((d) => (useLean ? cloneSaved(d) : hydrateSavedDoc(d)));
        })
        .then(ok, ko),
  };
  return q;
});

jest.spyOn(SavedCar, 'create').mockImplementation(async (data) => {
  const doc = new SavedCar(data);
  await doc.validate();
  const conflict = [...savedStore.values()].find(
    (d) => String(d.user) === String(doc.user) && String(d.car) === String(doc.car)
  );
  if (conflict) {
    throw Object.assign(new Error('E11000 duplicate key error collection: saved_cars'), {
      name: 'MongoServerError',
      code: 11000,
      keyPattern: { user: 1, car: 1 },
    });
  }
  const now = new Date();
  const plain = {
    ...doc.toObject(),
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
  savedStore.set(String(plain._id), cloneSaved(plain));
  return SavedCar.hydrate(cloneSaved(plain));
});

jest.spyOn(SavedCar, 'findOneAndUpdate').mockImplementation((filter, update) =>
  chainable(() => {
    const found = [...savedStore.values()].find((d) => matchSaved(d, filter));
    if (!found) return null;
    if (update.$set) Object.assign(found, update.$set);
    found.updatedAt = new Date();
    return cloneSaved(found);
  })
);

jest.spyOn(SavedCar, 'findOneAndDelete').mockImplementation((filter) =>
  chainable(() => {
    const found = [...savedStore.values()].find((d) => matchSaved(d, filter));
    if (!found) return null;
    savedStore.delete(String(found._id));
    return cloneSaved(found);
  })
);

jest.spyOn(SavedCar, 'updateOne').mockImplementation(async (filter, update) => {
  const found = [...savedStore.values()].find((d) => matchSaved(d, filter));
  if (!found) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  if (update.$push?.priceAlerts) {
    const pushSpec = update.$push.priceAlerts;
    const entries = pushSpec.$each ? pushSpec.$each : [pushSpec];
    entries.forEach((entry) => {
      found.priceAlerts.push({
        _id: entry._id || new mongoose.Types.ObjectId(),
        ...entry,
      });
    });
    if (typeof pushSpec.$slice === 'number' && pushSpec.$slice < 0) {
      found.priceAlerts = found.priceAlerts.slice(pushSpec.$slice);
    }
  }
  found.updatedAt = new Date();
  return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
});

jest.spyOn(PriceHistory, 'updateOne').mockImplementation(async (filter, update) => {
  const ph = priceHistoryStore.get(String(filter._id));
  if (ph && update.$set) Object.assign(ph, update.$set);
  return { acknowledged: true, matchedCount: ph ? 1 : 0, modifiedCount: ph ? 1 : 0 };
});

// ── Test helpers ────────────────────────────────────────────────────────────

let phoneSeq = 10000000;
const nextPhone = () => {
  phoneSeq += 1;
  return `09${String(phoneSeq).slice(-8)}`;
};

const createCustomerAuth = async (overrides = {}) => {
  const { id, email } = await h.createUser({
    roleName: 'CUSTOMER',
    phone: nextPhone(),
    fullName: 'Nguyen Van Khach',
    ...overrides,
  });
  const token = signAccessToken(await h.User.findById(id).select('+tokenVersion'));
  return { userId: id, email, token };
};

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'X-Forwarded-For': h.nextIp(),
});

beforeEach(() => {
  h.reset();
  carStore.clear();
  savedStore.clear();
  priceHistoryStore.clear();
  carQueryCalls = 0;
});

// ════════════════════════════════════════════════════════════════════════════
// 1. SCHEMA VALIDATION
// ════════════════════════════════════════════════════════════════════════════

describe('SavedCar Mongoose schema', () => {
  test('validates a complete record, defaults priceAlertEnabled=true, and uses saved_cars collection', () => {
    const doc = new SavedCar({
      user: new mongoose.Types.ObjectId(),
      car: new mongoose.Types.ObjectId(),
      priceAtSave: 650000000,
    });

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.priceAlertEnabled).toBe(true);
    expect(doc.priceAlerts).toEqual([]);
    expect(SavedCar.collection.name).toBe('saved_cars');
  });

  test.each(['user', 'car', 'priceAtSave'])('rejects missing required field: %s', (field) => {
    const payload = {
      user: new mongoose.Types.ObjectId(),
      car: new mongoose.Types.ObjectId(),
      priceAtSave: 500000000,
    };
    delete payload[field];
    const err = new SavedCar(payload).validateSync();
    expect(err.errors[field]).toBeDefined();
  });

  test('rejects negative priceAtSave', () => {
    const err = new SavedCar({
      user: new mongoose.Types.ObjectId(),
      car: new mongoose.Types.ObjectId(),
      priceAtSave: -100,
    }).validateSync();
    expect(err.errors.priceAtSave).toBeDefined();
  });

  test('declares a unique compound index on { user: 1, car: 1 }', () => {
    const indexes = SavedCar.schema.indexes();
    const uniqueCompound = indexes.find(
      ([fields, opts]) => fields.user === 1 && fields.car === 1 && opts?.unique === true
    );
    expect(uniqueCompound).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. GUEST LOCALSTORAGE PREVIEW + SIGNUP PROMPT METADATA
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/v1/public/wishlist/preview (Guest localStorage mode)', () => {
  const PREVIEW_URL = '/api/v1/public/wishlist/preview';

  test('returns empty preview with LOCAL_STORAGE strategy & signupPrompt without hitting DB when ids is empty', async () => {
    const res = await request(h.app).get(PREVIEW_URL).set('X-Forwarded-For', h.nextIp());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      guestMode: true,
      storageStrategy: 'LOCAL_STORAGE',
      cars: [],
      unavailableIds: [],
    });
    expect(res.body.data.signupPrompt.required).toBe(true);
    expect(carQueryCalls).toBe(0);
    expect(savedStore.size).toBe(0);
  });

  test('returns allow-listed AVAILABLE cars in guest localStorage order, separates unavailableIds, and leaks zero internal fields', async () => {
    const c1 = putCar({ make: 'HONDA', model: 'CR-V' });
    const c2 = putCar({ make: 'MAZDA', model: 'CX-5' });
    const soldCar = putCar({ status: 'SOLD' });
    const unknownId = oid();

    const res = await request(h.app)
      .get(`${PREVIEW_URL}?ids=${c2._id},${soldCar._id},${c1._id},${unknownId}`)
      .set('X-Forwarded-For', h.nextIp());

    expect(res.status).toBe(200);
    expect(res.body.data.cars.map((c) => c._id)).toEqual([String(c2._id), String(c1._id)]);
    expect(res.body.data.unavailableIds).toEqual([String(soldCar._id), unknownId]);
    expect(res.body.data.cars[0].primaryImageUrl).toBe('https://cdn.trustcar.vn/primary.jpg');

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/SENTINEL/);
    ['vin', 'licensePlate', 'floorPrice', 'originalPrice', 'listedPrice', 'internalNotes', 'priceHistory', 'publicId'].forEach((forbidden) => {
      expect(serialized).not.toContain(`"${forbidden}"`);
    });
    expect(Object.keys(WISHLIST_CAR_PROJECTION).filter((k) => /vin|plate|floor|notes|history|publicId/i.test(k))).toEqual([]);
    expect(h.logs).toHaveLength(0);
  });

  test('rejects malformed hex IDs in guest preview with 422 VALIDATION_ERROR', async () => {
    const res = await request(h.app)
      .get(`${PREVIEW_URL}?ids=${oid()},not-an-id`)
      .set('X-Forwarded-For', h.nextIp());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(carQueryCalls).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. AUTHENTICATION & AUTHORIZATION GUARDS
// ════════════════════════════════════════════════════════════════════════════

describe('Authentication & RBAC on /api/v1/customer/wishlist', () => {
  const BASE = '/api/v1/customer/wishlist';

  test('unauthenticated Guest gets 401 TOKEN_MISSING on persistent wishlist endpoints (triggers Signup Prompt Popup)', async () => {
    const car = putCar();

    const postRes = await request(h.app)
      .post(BASE)
      .set('X-Forwarded-For', h.nextIp())
      .send({ carId: car._id });

    expect(postRes.status).toBe(401);
    expect(postRes.body.code).toBe('TOKEN_MISSING');
    expect(savedStore.size).toBe(0);

    const getRes = await request(h.app).get(BASE).set('X-Forwarded-For', h.nextIp());
    expect(getRes.status).toBe(401);
  });

  test.each(['ADMIN', 'SALES_STAFF'])(
    'staff role %s is rejected with 403 ROLE_INSUFFICIENT',
    async (roleName) => {
      const { id } = await h.createUser({ roleName });
      const token = signAccessToken(await h.User.findById(id).select('+tokenVersion'));
      const res = await request(h.app).get(BASE).set(authHeaders(token));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_INSUFFICIENT');
    }
  );

  test('customer with incomplete profile (Google sign-in pending completion) gets 403 PROFILE_INCOMPLETE', async () => {
    const { id } = await h.createUser({
      roleName: 'CUSTOMER',
      firebaseUid: 'firebase-incomplete-1',
      password: null,
      fullName: undefined,
    });
    const token = signAccessToken(await h.User.findById(id).select('+tokenVersion'));
    const res = await request(h.app).get(BASE).set(authHeaders(token));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PROFILE_INCOMPLETE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. WISHLIST CRUD, IDEMPOTENCY, OWNERSHIP & SERVER-SIDE PRICE SNAPSHOT
// ════════════════════════════════════════════════════════════════════════════

describe('Customer Saved Cars Wishlist CRUD & Price Comparison', () => {
  const BASE = '/api/v1/customer/wishlist';

  test('saves an AVAILABLE car (201), snapshots server-side Car.price, and is idempotent on repeat save (200)', async () => {
    const { token } = await createCustomerAuth();
    const car = putCar({ price: 650000000 });

    // First save -> 201 Created
    const first = await request(h.app)
      .post(BASE)
      .set(authHeaders(token))
      .send({ carId: car._id });

    expect(first.status).toBe(201);
    expect(first.body.data.alreadySaved).toBe(false);
    expect(first.body.data.item).toMatchObject({
      carId: String(car._id),
      priceAtSave: 650000000,
      currentPrice: 650000000,
      priceDropped: false,
      dropAmount: 0,
      priceAlertEnabled: true,
    });

    // Even if car price later drops to 620M, re-saving must NOT overwrite original priceAtSave (650M)
    carStore.get(String(car._id)).price = 620000000;

    const duplicate = await request(h.app)
      .post(BASE)
      .set(authHeaders(token))
      .send({ carId: car._id });

    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.alreadySaved).toBe(true);
    expect(duplicate.body.data.item.priceAtSave).toBe(650000000);
    expect(duplicate.body.data.item.currentPrice).toBe(620000000);
    expect(duplicate.body.data.item.priceDropped).toBe(true);
    expect(duplicate.body.data.item.dropAmount).toBe(30000000);
    expect(savedStore.size).toBe(1);
  });

  test('strips client-supplied priceAtSave and always snapshots authoritative server-side Car.price', async () => {
    const { token } = await createCustomerAuth();
    const car = putCar({ price: 500000000 });

    const res = await request(h.app)
      .post(BASE)
      .set(authHeaders(token))
      .send({ carId: car._id, priceAtSave: 999999999 });

    expect(res.status).toBe(201);
    expect(res.body.data.item.priceAtSave).toBe(500000000);
    expect([...savedStore.values()][0].priceAtSave).toBe(500000000);
  });

  test('validates malformed carId and non-boolean priceAlertEnabled with 422', async () => {
    const { token } = await createCustomerAuth();

    const badSave = await request(h.app)
      .post(BASE)
      .set(authHeaders(token))
      .send({ carId: 'invalid-id' });
    expect(badSave.status).toBe(422);
    expect(badSave.body.code).toBe('VALIDATION_ERROR');

    const badParam = await request(h.app)
      .delete(`${BASE}/not-hex`)
      .set(authHeaders(token));
    expect(badParam.status).toBe(422);
    expect(badParam.body.code).toBe('INVALID_OBJECT_ID');
  });

  test('rejects saving SOLD, DELISTED, INCOMING, or non-existent vehicles with 404 NOT_FOUND', async () => {
    const { token } = await createCustomerAuth();
    const sold = putCar({ status: 'SOLD' });
    const incoming = putCar({ status: 'INCOMING' });

    for (const targetId of [sold._id, incoming._id, oid()]) {
      const res = await request(h.app)
        .post(BASE)
        .set(authHeaders(token))
        .send({ carId: targetId });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect(savedStore.size).toBe(0);
  });

  test('enforces MAX_WISHLIST_ITEMS (100) per user with 422 WISHLIST_LIMIT_EXCEEDED', async () => {
    const { userId, token } = await createCustomerAuth();
    for (let i = 0; i < MAX_WISHLIST_ITEMS; i += 1) {
      const c = putCar();
      await SavedCar.create({ user: userId, car: c._id, priceAtSave: c.price });
    }

    const extraCar = putCar();
    const res = await request(h.app)
      .post(BASE)
      .set(authHeaders(token))
      .send({ carId: extraCar._id });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('WISHLIST_LIMIT_EXCEEDED');
  });

  test('isolates wishlists per customer, reports SOLD status as isAvailable=false without leaking internal fields, and supports toggle/delete', async () => {
    const customerA = await createCustomerAuth();
    const customerB = await createCustomerAuth();

    const car1 = putCar({ price: 900000000 });
    const car2 = putCar({ price: 700000000 });

    await request(h.app).post(BASE).set(authHeaders(customerA.token)).send({ carId: car1._id });
    await request(h.app).post(BASE).set(authHeaders(customerB.token)).send({ carId: car2._id });

    // Car1 later gets SOLD
    carStore.get(String(car1._id)).status = 'SOLD';

    const listA = await request(h.app).get(BASE).set(authHeaders(customerA.token));
    expect(listA.status).toBe(200);
    expect(listA.body.data).toHaveLength(1);
    expect(listA.body.data[0].carId).toBe(String(car1._id));
    expect(listA.body.data[0].isAvailable).toBe(false);
    expect(listA.body.data[0].car.isAvailable).toBe(false);
    expect(JSON.stringify(listA.body)).not.toMatch(/SENTINEL|"status"|"isActive"/);

    // Lightweight /ids endpoint
    const idsA = await request(h.app).get(`${BASE}/ids`).set(authHeaders(customerA.token));
    expect(idsA.status).toBe(200);
    expect(idsA.body.data).toEqual({
      carIds: [String(car1._id)],
      totalSaved: 1,
      unreadAlertsCount: 0,
    });

    // Customer A cannot toggle or delete Customer B's saved car
    const forbiddenToggle = await request(h.app)
      .patch(`${BASE}/${car2._id}/alert`)
      .set(authHeaders(customerA.token))
      .send({ priceAlertEnabled: false });
    expect(forbiddenToggle.status).toBe(404);
    expect(forbiddenToggle.body.code).toBe('WISHLIST_ITEM_NOT_FOUND');

    const forbiddenDelete = await request(h.app)
      .delete(`${BASE}/${car2._id}`)
      .set(authHeaders(customerA.token));
    expect(forbiddenDelete.status).toBe(404);

    // Customer A toggles alert off and deletes their own saved car
    const toggleOwn = await request(h.app)
      .patch(`${BASE}/${car1._id}/alert`)
      .set(authHeaders(customerA.token))
      .send({ priceAlertEnabled: false });
    expect(toggleOwn.status).toBe(200);
    expect(toggleOwn.body.data.priceAlertEnabled).toBe(false);

    const deleteOwn = await request(h.app)
      .delete(`${BASE}/${car1._id}`)
      .set(authHeaders(customerA.token));
    expect(deleteOwn.status).toBe(200);
    expect(deleteOwn.body.data).toEqual({ carId: String(car1._id), removed: true });
    expect(savedStore.size).toBe(1); // Customer B's item remains untouched
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. POST-SIGNUP / POST-LOGIN GUEST LOCALSTORAGE SYNC
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/customer/wishlist/sync (Guest localStorage -> Account DB)', () => {
  const SYNC_URL = '/api/v1/customer/wishlist/sync';

  test('syncs available localStorage cars, preserves already-saved priceAtSave, lists unavailableIds, and instructs client to clear localStorage', async () => {
    const { userId, token } = await createCustomerAuth();

    const alreadyCar = putCar({ price: 600000000 });
    await SavedCar.create({ user: userId, car: alreadyCar._id, priceAtSave: 640000000 });

    const newCar1 = putCar({ price: 520000000 });
    const newCar2 = putCar({ price: 810000000 });
    const soldCar = putCar({ status: 'SOLD' });

    const res = await request(h.app)
      .post(SYNC_URL)
      .set(authHeaders(token))
      .send({
        carIds: [newCar1._id, alreadyCar._id, soldCar._id, newCar2._id, newCar1._id],
        priceAlertEnabled: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      syncedCount: 2,
      alreadySavedCount: 1,
      unavailableIds: [String(soldCar._id)],
      clearLocalStorage: true,
    });
    expect(res.body.data.items.map((i) => i.carId)).toEqual([
      String(newCar1._id),
      String(alreadyCar._id),
      String(newCar2._id),
    ]);
    // Already-saved item keeps its historical priceAtSave (640M), so 600M shows a 40M drop!
    const preserved = res.body.data.items.find((i) => i.carId === String(alreadyCar._id));
    expect(preserved.priceAtSave).toBe(640000000);
    expect(preserved.priceDropped).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. AUTOMATED PRICE DROP ALERTS (EMAIL + IN-APP FEED + READ STATUS)
// ════════════════════════════════════════════════════════════════════════════

describe('Price Drop Alerts engine & customer alert endpoints', () => {
  const BASE = '/api/v1/customer/wishlist';

  test('notifies subscribed active customers via email + in-app alert, skips opted-out/inactive users, and updates PriceHistory', async () => {
    const subActive = await createCustomerAuth({ fullName: 'Le Thi Hoa' });
    const subOptOut = await createCustomerAuth({ fullName: 'Tran Van Tat' });
    const subInactive = await createCustomerAuth({ fullName: 'Pham Bi Khoa', isActive: false });

    const car = putCar({ make: 'HYUNDAI', model: 'Tucson', year: 2023, price: 850000000 });

    await SavedCar.create({ user: subActive.userId, car: car._id, priceAtSave: 850000000, priceAlertEnabled: true });
    await SavedCar.create({ user: subOptOut.userId, car: car._id, priceAtSave: 850000000, priceAlertEnabled: false });
    await SavedCar.create({ user: subInactive.userId, car: car._id, priceAtSave: 850000000, priceAlertEnabled: true });

    // Price drops from 850M -> 815M
    carStore.get(String(car._id)).price = 815000000;
    const phId = oid();
    priceHistoryStore.set(phId, { _id: phId, notifiedLeadsCount: 0 });

    const result = await notifyPriceDropForCar({
      carId: car._id,
      oldPrice: 850000000,
      newPrice: 815000000,
      priceHistoryId: phId,
    });

    expect(result).toEqual({ notifiedCount: 1, emailedCount: 1 });
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0].to).toBe(subActive.email);
    expect(h.mail.sent[0].subject).toContain('Tucson');
    expect(priceHistoryStore.get(phId).notifiedLeadsCount).toBe(1);

    // Fetch alerts via API for subActive
    const alertsRes = await request(h.app)
      .get(`${BASE}/alerts?unreadOnly=true`)
      .set(authHeaders(subActive.token));

    expect(alertsRes.status).toBe(200);
    expect(alertsRes.body.meta.unreadAlertsCount).toBe(1);
    expect(alertsRes.body.data).toHaveLength(1);
    const alert = alertsRes.body.data[0];
    expect(alert).toMatchObject({
      carId: String(car._id),
      oldPrice: 850000000,
      newPrice: 815000000,
      dropAmount: 35000000,
      emailSent: true,
      isRead: false,
    });

    // Opted-out customer cannot mark subActive's alert as read -> 404
    const crossRead = await request(h.app)
      .patch(`${BASE}/alerts/${alert._id}/read`)
      .set(authHeaders(subOptOut.token));
    expect(crossRead.status).toBe(404);
    expect(crossRead.body.code).toBe('PRICE_ALERT_NOT_FOUND');

    // subActive marks the alert as read
    const markRes = await request(h.app)
      .patch(`${BASE}/alerts/${alert._id}/read`)
      .set(authHeaders(subActive.token));
    expect(markRes.status).toBe(200);
    expect(markRes.body.data.isRead).toBe(true);

    // Unread filter now returns 0
    const afterRead = await request(h.app)
      .get(`${BASE}/alerts?unreadOnly=true`)
      .set(authHeaders(subActive.token));
    expect(afterRead.body.data).toHaveLength(0);
    expect(afterRead.body.meta.unreadAlertsCount).toBe(0);
  });

  test('SMTP failure does not block in-app price drop alerts, and markAllAlertsRead marks all caller alerts read', async () => {
    const customer = await createCustomerAuth();
    const car = putCar({ price: 700000000 });
    await SavedCar.create({ user: customer.userId, car: car._id, priceAtSave: 700000000, priceAlertEnabled: true });

    h.mail.fail = true;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      carStore.get(String(car._id)).price = 680000000;
      const r1 = await notifyPriceDropForCar({ carId: car._id, oldPrice: 700000000, newPrice: 680000000 });
      expect(r1).toEqual({ notifiedCount: 1, emailedCount: 0 });

      carStore.get(String(car._id)).price = 660000000;
      const r2 = await notifyPriceDropForCar({ carId: car._id, oldPrice: 680000000, newPrice: 660000000 });
      expect(r2).toEqual({ notifiedCount: 1, emailedCount: 0 });
    } finally {
      errorSpy.mockRestore();
    }

    const markAll = await request(h.app)
      .patch(`${BASE}/alerts/read-all`)
      .set(authHeaders(customer.token));
    expect(markAll.status).toBe(200);
    expect(markAll.body.data).toEqual({ markedCount: 2 });
  });

  test('does not send alerts on price increase or when car is not AVAILABLE', async () => {
    const customer = await createCustomerAuth();
    const car = putCar({ price: 500000000 });
    await SavedCar.create({ user: customer.userId, car: car._id, priceAtSave: 500000000, priceAlertEnabled: true });

    // Price increase -> ignored
    const inc = await notifyPriceDropForCar({ carId: car._id, oldPrice: 500000000, newPrice: 520000000 });
    expect(inc).toEqual({ notifiedCount: 0, emailedCount: 0 });

    // Non-AVAILABLE car -> ignored
    carStore.get(String(car._id)).status = 'RESERVED';
    const reserved = await notifyPriceDropForCar({ carId: car._id, oldPrice: 500000000, newPrice: 480000000 });
    expect(reserved).toEqual({ notifiedCount: 0, emailedCount: 0 });
    expect(h.mail.sent).toHaveLength(0);
  });
});

