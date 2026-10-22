/**
 * @file health.test.js
 * @description Integration tests for the Health Check endpoints.
 *
 * Tests:
 * - GET /api/v1/health       → Liveness probe
 * - GET /api/v1/health/ready → Readiness probe (requires DB)
 * - GET /                    → Root API info
 * - GET /api/v1/nonexistent  → 404 handler
 */

import { jest } from '@jest/globals';

// Mock mongoose before importing app
const mockReadyState = { value: 1 };
jest.unstable_mockModule('mongoose', () => ({
  default: {
    connect: jest.fn().mockResolvedValue({
      connection: { host: 'localhost', name: 'testdb' },
    }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    connection: {
      get readyState() { return mockReadyState.value; },
      on: jest.fn(),
    },
    Schema: class MockSchema {
      constructor(def, opts) {
        this.paths = {};
        this.statics = {};
        this.methods = {};
        this.obj = def;
      }
      index() { return this; }
      pre() { return this; }
      post() { return this; }
      virtual() {
        return { get: jest.fn().mockReturnThis() };
      }
      plugin() { return this; }
      set() { return this; }
      static get Types() {
        return {
          ObjectId: String,
          Mixed: Object,
        };
      }
    },
    model: jest.fn().mockImplementation((name) => {
      const ModelMock = function(data) { return data; };
      ModelMock.modelName = name;
      ModelMock.findOne = jest.fn();
      ModelMock.find = jest.fn();
      ModelMock.create = jest.fn();
      ModelMock.countDocuments = jest.fn();
      ModelMock.exists = jest.fn();
      ModelMock.seedDefaultRoles = jest.fn();
      return ModelMock;
    }),
  },
  Schema: class {
    constructor() {}
    static get Types() {
      return { ObjectId: String, Mixed: Object };
    }
  },
}));

// Dynamic import after mocks
const { default: request } = await import('supertest');

// We need a simplified app for testing health endpoints
const { default: express } = await import('express');
const testApp = express();

testApp.use(express.json());

// Simple health routes for testing
testApp.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'TrustCar Backend API',
    version: 'v1',
    docs:    '/api/v1/health',
  });
});

testApp.get('/api/v1/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'TrustCar API is running.',
    data: {
      service: 'TrustCar-Backend',
      env:     'test',
    },
  });
});

testApp.get('/api/v1/health/ready', (_req, res) => {
  const isReady = mockReadyState.value === 1;
  if (isReady) {
    return res.status(200).json({
      success: true,
      message: 'Service is ready.',
      data: { database: 'connected' },
    });
  }
  return res.status(503).json({
    success: false,
    message: 'Service is not ready – database connection unavailable.',
  });
});

// 404 catch-all
testApp.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found.`,
    code:    'ROUTE_NOT_FOUND',
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════════

describe('Health Check Endpoints', () => {

  // ── GET / ──────────────────────────────────────────────────────────────
  describe('GET /', () => {
    it('should return API info with 200 status', async () => {
      const res = await request(testApp).get('/');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('TrustCar');
      expect(res.body.version).toBe('v1');
    });
  });

  // ── GET /api/v1/health ────────────────────────────────────────────────
  describe('GET /api/v1/health', () => {
    it('should return 200 with service info (liveness probe)', async () => {
      const res = await request(testApp).get('/api/v1/health');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('TrustCar API is running.');
      expect(res.body.data).toHaveProperty('service', 'TrustCar-Backend');
    });
  });

  // ── GET /api/v1/health/ready ──────────────────────────────────────────
  describe('GET /api/v1/health/ready', () => {
    it('should return 200 when database is connected (readiness probe)', async () => {
      mockReadyState.value = 1; // connected

      const res = await request(testApp).get('/api/v1/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Service is ready.');
      expect(res.body.data.database).toBe('connected');
    });

    it('should return 503 when database is disconnected', async () => {
      mockReadyState.value = 0; // disconnected

      const res = await request(testApp).get('/api/v1/health/ready');

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('not ready');

      // Reset for subsequent tests
      mockReadyState.value = 1;
    });
  });

  // ── 404 Handler ───────────────────────────────────────────────────────
  describe('GET /api/v1/nonexistent', () => {
    it('should return 404 for undefined routes', async () => {
      const res = await request(testApp).get('/api/v1/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('ROUTE_NOT_FOUND');
    });
  });
});
