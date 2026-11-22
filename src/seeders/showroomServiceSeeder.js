/**
 * @file showroomServiceSeeder.js
 * @description Seeds the 6 default showroom service packages on first startup
 * (KAN-96). Idempotent: checks existence by `code`, so re-running after an
 * admin tweak preserves the admin's changes to serviceName / referencePrice /
 * description. Only packages that are missing by code get created.
 */

import ShowroomService from '../models/showroom-service.model.js';
import { RecordStatus } from '../models/extendedEnums.js';

const SEED = [
  {
    code: 'CAR_WASH_PREMIUM',
    serviceName: 'Rửa xe cao cấp',
    description: 'Rửa ngoài, hút nội thất, dưỡng taplo, lau kính sạch sâu.',
    estimatedDuration: 60,
    referencePrice: 200_000,
  },
  {
    code: 'POLISH',
    serviceName: 'Đánh bóng sơn',
    description: 'Xóa xước mờ, phục hồi độ bóng, đánh 2 bước bằng máy chuyên dụng.',
    estimatedDuration: 180,
    referencePrice: 800_000,
  },
  {
    code: 'CERAMIC_COATING',
    serviceName: 'Phủ nano ceramic',
    description: 'Phủ ceramic 9H, bảo vệ sơn 12 tháng, chống xước nhẹ.',
    estimatedDuration: 240,
    referencePrice: 3_000_000,
  },
  {
    code: 'UNDERBODY_COATING',
    serviceName: 'Bọc gầm cách âm',
    description: 'Phủ vật liệu cao su chống rỉ, cách âm gầm toàn xe.',
    estimatedDuration: 180,
    referencePrice: 1_500_000,
  },
  {
    code: 'INTERIOR_DETAIL',
    serviceName: 'Detailing nội thất',
    description: 'Vệ sinh ghế da, trần, thảm, dưỡng nhựa, khử mùi ozone.',
    estimatedDuration: 180,
    referencePrice: 1_000_000,
  },
  {
    code: 'GENERAL_INSPECTION',
    serviceName: 'Kiểm tra tổng quát',
    description: 'Check 60 hạng mục: động cơ, phanh, lốp, ắc-quy, điều hoà — xuất báo cáo PDF.',
    estimatedDuration: 90,
    referencePrice: 300_000,
  },
];

/**
 * Upserts missing packages by `code`. Existing packages are left as-is so an
 * admin's edits are never clobbered by a subsequent restart.
 * @returns {Promise<{ created: number, skipped: number }>}
 */
export const seedShowroomServices = async () => {
  let created = 0;
  let skipped = 0;
  for (const spec of SEED) {
    // eslint-disable-next-line no-await-in-loop
    const existed = await ShowroomService.findOne({ code: spec.code }).lean();
    if (existed) { skipped += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    await ShowroomService.create({ ...spec, status: RecordStatus.ACTIVE });
    created += 1;
  }
  console.log(`📋  Service seeder: ${created} created, ${skipped} already present.`);
  return { created, skipped };
};

export default { seedShowroomServices };
