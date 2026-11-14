/**
 * @file price-history.test.js
 * @description Schema-level checks for PriceHistory and the Car fields added for KAN-8
 * (ownerType, floorPrice). No database connection is opened.
 */

import mongoose from 'mongoose';
import PriceHistory from '../src/models/PriceHistory.js';
import Car from '../src/models/Car.js';

const objectId = () => new mongoose.Types.ObjectId();

const validMarkdown = () => ({
  carId:      objectId(),
  changedBy:  objectId(),
  oldPrice:   480000000,
  newPrice:   475000000,
  dropAmount: 5000000,
  reason:     'Customer negotiation - price reduced',
});

describe('PriceHistory schema', () => {
  test('accepts a complete markdown record and defaults notifiedLeadsCount to 0', () => {
    const doc = new PriceHistory(validMarkdown());

    expect(doc.validateSync()).toBeUndefined();
    expect(doc.notifiedLeadsCount).toBe(0);
  });

  test.each(['carId', 'changedBy', 'oldPrice', 'newPrice', 'dropAmount'])(
    'rejects a record without %s',
    (field) => {
      const data = validMarkdown();
      delete data[field];

      const error = new PriceHistory(data).validateSync();

      expect(error.errors[field]).toBeDefined();
    },
  );

  test('is stored in the pricehistories collection', () => {
    expect(PriceHistory.collection.name).toBe('pricehistories');
  });
});

describe('Car fields used by the price seed', () => {
  test('ownerType defaults to INDIVIDUAL and accepts COMPANY', () => {
    expect(new Car({}).ownerType).toBe('INDIVIDUAL');
    expect(new Car({ ownerType: 'COMPANY' }).validateSync()?.errors.ownerType).toBeUndefined();
  });

  test('ownerType rejects values outside COMPANY / INDIVIDUAL', () => {
    const error = new Car({ ownerType: 'CN' }).validateSync();

    expect(error.errors.ownerType).toBeDefined();
  });

  test('floorPrice defaults to 0 and priceHistory entries keep price, changedBy and reason', () => {
    const car = new Car({
      priceHistory: [{ price: 1250000000, changedBy: objectId(), reason: 'Initial intake price' }],
    });

    expect(car.floorPrice).toBe(0);
    expect(car.priceHistory[0].price).toBe(1250000000);
    expect(car.priceHistory[0].reason).toBe('Initial intake price');
  });
});
