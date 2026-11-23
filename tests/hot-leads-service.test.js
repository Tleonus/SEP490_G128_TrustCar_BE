/**
 * @file hot-leads-service.test.js
 * @description KAN-97 — listHotLeads: lọc đúng isActive + stage scorable + scoreBand HOT,
 * sắp theo score desc + lastInteractionAt desc, phân trang bằng limit.
 */

import { jest } from '@jest/globals';
import mongoose from 'mongoose';
import Lead from '../src/models/Lead.js';
import { listHotLeads } from '../src/services/leadService.js';

const oid = () => new mongoose.Types.ObjectId();

let leadStore;

beforeEach(() => {
  leadStore = [];

  const buildChain = (rows) => {
    const chain = {
      populate: () => chain,
      sort: (spec) => {
        chain._sort = spec;
        return chain;
      },
      limit: (n) => {
        chain._limit = n;
        return chain;
      },
      lean: async () => {
        let result = [...rows];
        if (chain._sort) {
          const entries = Object.entries(chain._sort);
          result.sort((a, b) => {
            for (const [key, dir] of entries) {
              const av = a[key]; const bv = b[key];
              if (av == null && bv == null) continue;
              if (av == null) return dir > 0 ? -1 : 1;
              if (bv == null) return dir > 0 ? 1 : -1;
              if (av < bv) return dir > 0 ? -1 : 1;
              if (av > bv) return dir > 0 ? 1 : -1;
            }
            return 0;
          });
        }
        if (chain._limit != null) result = result.slice(0, chain._limit);
        return result;
      },
    };
    return chain;
  };

  jest.spyOn(Lead, 'find').mockImplementation((filter) => {
    const matching = leadStore.filter((lead) => {
      if (filter.isActive !== undefined && lead.isActive !== filter.isActive) return false;
      if (filter.stage?.$in && !filter.stage.$in.includes(lead.stage)) return false;
      if (filter.scoreBand && lead.scoreBand !== filter.scoreBand) return false;
      return true;
    });
    return buildChain(matching);
  });
  jest.spyOn(Lead, 'countDocuments').mockImplementation(async (filter) => {
    return leadStore.filter((lead) => {
      if (filter.scoreBand && lead.scoreBand !== filter.scoreBand) return false;
      if (filter.isActive !== undefined && lead.isActive !== filter.isActive) return false;
      if (filter.stage?.$in && !filter.stage.$in.includes(lead.stage)) return false;
      return true;
    }).length;
  });
});

afterEach(() => jest.restoreAllMocks());

const makeLead = (overrides) => ({
  _id: oid(), leadCode: 'LD-0000', stage: 'NEW', scoreBand: 'HOT', isActive: true,
  score: 80, lastInteractionAt: new Date('2026-12-04T00:00:00Z'), ...overrides,
});

describe('listHotLeads', () => {
  it('chỉ trả lead HOT đang mở, sort theo score desc', async () => {
    leadStore.push(
      makeLead({ leadCode: 'LD-A', score: 72 }),
      makeLead({ leadCode: 'LD-B', score: 95 }),
      makeLead({ leadCode: 'LD-C', score: 88 }),
      makeLead({ leadCode: 'LD-D', score: 85, scoreBand: 'WARM' }), // bị loại
      makeLead({ leadCode: 'LD-E', score: 90, stage: 'WON' }),       // bị loại
      makeLead({ leadCode: 'LD-F', score: 99, isActive: false }),    // bị loại
    );

    const { items, pagination } = await listHotLeads({ limit: 10 });

    expect(items.map((l) => l.leadCode)).toEqual(['LD-B', 'LD-C', 'LD-A']);
    expect(pagination.total).toBe(3);
  });

  it('cùng score → sort theo lastInteractionAt desc', async () => {
    leadStore.push(
      makeLead({ leadCode: 'LD-X', score: 80, lastInteractionAt: new Date('2026-12-01T00:00:00Z') }),
      makeLead({ leadCode: 'LD-Y', score: 80, lastInteractionAt: new Date('2026-12-04T00:00:00Z') }),
    );

    const { items } = await listHotLeads({ limit: 10 });
    expect(items.map((l) => l.leadCode)).toEqual(['LD-Y', 'LD-X']);
  });

  it('tôn trọng limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      leadStore.push(makeLead({ leadCode: `LD-${i}`, score: 80 + i }));
    }

    const { items } = await listHotLeads({ limit: 2 });
    expect(items).toHaveLength(2);
  });

  it('không có lead HOT → items rỗng, total 0', async () => {
    leadStore.push(makeLead({ scoreBand: 'COLD' }));
    const { items, pagination } = await listHotLeads({ limit: 20 });
    expect(items).toEqual([]);
    expect(pagination.total).toBe(0);
  });

  it('limit mặc định 20 khi không truyền', async () => {
    for (let i = 0; i < 25; i += 1) {
      leadStore.push(makeLead({ leadCode: `LD-${i}`, score: 71 + (i % 20) }));
    }

    const { items } = await listHotLeads({});
    expect(items).toHaveLength(20);
  });
});
