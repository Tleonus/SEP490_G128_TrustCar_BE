import mongoose from 'mongoose';
import {
  Brand,
  ChatMessage,
  Feedback,
  RecommendationBatch,
  SaleRecord,
  SystemSetting,
  User,
} from '../src/models/index.js';

const objectId = () => new mongoose.Types.ObjectId();

describe('TrustCar database model integration', () => {
  test('registers the existing API models and the ERD-only models together', () => {
    const names = mongoose.modelNames();

    expect(names).toEqual(expect.arrayContaining([
      'User',
      'Role',
      'Car',
      'Brand',
      'ChatMessage',
      'Feedback',
      'RecommendationBatch',
      'SaleRecord',
      'SystemSetting',
      'VisitorSession',
    ]));
  });

  test('keeps the existing User model contract', () => {
    expect(User.schema.path('password')).toBeDefined();
    expect(User.schema.path('role')).toBeDefined();
  });

  test('validates ERD-only model rules without a database connection', async () => {
    const staffMessage = new ChatMessage({
      conversationId: objectId(),
      senderType: 'STAFF',
      content: 'Hello',
    });
    await expect(staffMessage.validate()).rejects.toThrow();

    const invalidRating = new Feedback({ customerName: 'Test', rating: 6, content: 'Bad' });
    await expect(invalidRating.validate()).rejects.toThrow();

    const batchWithoutOwner = new RecommendationBatch({ algorithmType: 'rule' });
    await expect(batchWithoutOwner.validate()).rejects.toThrow();

    const validBrand = new Brand({ brandName: 'TrustCar Test' });
    await expect(validBrand.validate()).resolves.toBeUndefined();

    const validSale = new SaleRecord({
      customerId: objectId(),
      carId: objectId(),
      recordedByUserId: objectId(),
      saleDate: new Date(),
      finalPrice: 100,
    });
    await expect(validSale.validate()).resolves.toBeUndefined();

    const validSetting = new SystemSetting({
      settingKey: 'test.key',
      value: true,
      groupName: 'test',
    });
    await expect(validSetting.validate()).resolves.toBeUndefined();
  });
});
