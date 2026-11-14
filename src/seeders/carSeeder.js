/**
 * @file carSeeder.js
 * @description Seeds 29 test cars taken from the showroom price list (listxe.pdf).
 *
 * Usage:
 *   node src/seeders/carSeeder.js           -> dry run: prints what would be inserted, writes nothing
 *   node src/seeders/carSeeder.js --apply   -> inserts into the database from MONGODB_URI
 *
 * Notes:
 * - VIN and licensePlate are NOT in the price list; they are fake, deterministic values
 *   (VIN prefix "TCSEED", plate "30K-...") so seeded cars are easy to recognise and clean up.
 * - Idempotent: cars whose VIN already exists are skipped.
 * - Needs an active ADMIN user for createdBy: with --apply it creates the default roles and admin
 *   (same as server startup) if none exists. Dry run never writes.
 * - Also fills floorPrice, listedDate/daysInStock/agingCategory, Car.priceHistory and, for older
 *   or high-mileage cars, one markdown record in the pricehistories collection (mock data).
 * - Prices in the source list are in million VND; stored here in VND.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import Car from '../models/Car.js';
import PriceHistory from '../models/PriceHistory.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import { seedAdminAccount } from './adminSeeder.js';
import { Roles, CarStatus } from '../constants/appConstants.js';
import { generateVehicleCode } from '../utils/codeGenerator.js';

const MILLION = 1_000_000;

// [make, model, variant, year, fuel, color, interior, seats, body, km, ownerType, buyPrice, listPrice]
// buyPrice ("giá thu") -> originalPrice, listPrice ("giá chào") -> price/listedPrice, both in million VND.
// CUV in the source list is stored as SUV (no CUV in BodyType).
const CAR_ROWS = [
  ['FORD', 'Everest', 'Titanium 4x4', 2024, 'DIESEL', 'Đen', 'Đen', 7, 'SUV', 52000, 'INDIVIDUAL', 1225, 1250],
  ['FORD', 'Everest', 'Titanium 4x2', 2025, 'DIESEL', 'Đen', 'Đen', 7, 'SUV', 15000, 'INDIVIDUAL', 1190, 1219],
  ['FORD', 'Everest', 'Sport 4x2', 2025, 'DIESEL', 'Đen', 'Đen', 7, 'SUV', 26000, 'COMPANY', 1125, 1150],
  ['FORD', 'Territory', 'Titanium X (mới 100%)', 2026, 'GASOLINE', 'Xanh', 'Đen', 5, 'SUV', 5, 'INDIVIDUAL', 855, 870],
  ['FORD', 'Territory', 'Titanium', 2026, 'GASOLINE', 'Đen', 'Đen', 5, 'SUV', 8000, 'INDIVIDUAL', 765, 780],
  ['FORD', 'Territory', 'Titanium X', 2024, 'GASOLINE', 'Trắng', 'Đen', 5, 'SUV', 40000, 'INDIVIDUAL', 710, 730],
  ['FORD', 'Ranger', 'XLS 4x2', 2025, 'DIESEL', 'Đen', 'Đen', 5, 'PICKUP', 20000, 'INDIVIDUAL', 635, 655],
  ['FORD', 'Ranger', 'XLS 4x2', 2020, 'DIESEL', 'Trắng', 'Đen', 5, 'PICKUP', 65000, 'INDIVIDUAL', 460, 475],
  ['FORD', 'Ranger', 'XLS 4x2', 2018, 'DIESEL', 'Ghi vàng', 'Đen', 5, 'PICKUP', 140000, 'INDIVIDUAL', 425, 440],
  ['FORD', 'Ranger', 'Wildtrak', 2021, 'DIESEL', 'Đen', 'Đen', 5, 'PICKUP', 100000, 'INDIVIDUAL', 585, 599],
  ['FORD', 'EcoSport', 'Titanium', 2018, 'GASOLINE', 'Xám', 'Đen', 5, 'SUV', 30000, 'INDIVIDUAL', 350, 365],
  ['HYUNDAI', 'Santa Fe', 'Premium', 2020, 'GASOLINE', 'Đen', 'Nâu', 7, 'SUV', 68000, 'INDIVIDUAL', 720, 735],
  ['HYUNDAI', 'Santa Fe', 'Premium', 2019, 'GASOLINE', 'Trắng', 'Nâu', 7, 'SUV', 70000, 'INDIVIDUAL', 655, 685],
  ['HYUNDAI', 'Santa Fe', 'Premium', 2019, 'DIESEL', 'Đen', 'Nâu', 7, 'SUV', 88000, 'INDIVIDUAL', 720, 735],
  ['HYUNDAI', 'i10', '1.2 AT', 2021, 'GASOLINE', 'Đỏ', 'Đen', 5, 'HATCHBACK', 32000, 'INDIVIDUAL', 320, 330],
  ['HYUNDAI', 'Accent', '1.5 AT (form 2025)', 2024, 'GASOLINE', 'Xanh', 'Đen', 5, 'SEDAN', 22000, 'INDIVIDUAL', 445, 460],
  ['HYUNDAI', 'Tucson', '1.6 Turbo', 2021, 'GASOLINE', 'Trắng', 'Đen', 5, 'SUV', 70000, 'INDIVIDUAL', 660, 675],
  ['PEUGEOT', '3008', 'GT Line', 2022, 'GASOLINE', 'Cam', 'Nâu', 5, 'SUV', 71000, 'INDIVIDUAL', 645, 660],
  ['TOYOTA', 'Camry', '2.5Q', 2022, 'GASOLINE', 'Đen', 'Kem', 5, 'SEDAN', 60000, 'INDIVIDUAL', 990, 1025],
  ['TOYOTA', 'Hilux', '2.8 Pro 4x2 AT (form 2026)', 2025, 'DIESEL', 'Bạc', 'Đen', 5, 'PICKUP', 20000, 'INDIVIDUAL', 660, 679],
  ['MAZDA', 'Mazda3', 'Luxury', 2024, 'GASOLINE', 'Trắng', 'Đen', 5, 'SEDAN', 26000, 'INDIVIDUAL', 570, 585],
  ['MAZDA', 'Mazda3', 'Luxury', 2025, 'GASOLINE', 'Trắng', 'Đen', 5, 'SEDAN', 33000, 'INDIVIDUAL', 575, 590],
  ['MAZDA', 'CX-5', '2.5 Premium', 2020, 'GASOLINE', 'Trắng', 'Đen', 5, 'SUV', 120000, 'INDIVIDUAL', 620, 635],
  ['VINFAST', 'Lux A2.0', 'Premium', 2021, 'GASOLINE', 'Đen', 'Nâu da bò', 5, 'SEDAN', 110000, 'INDIVIDUAL', 485, 499],
  ['VINFAST', 'Lux SA2.0', 'Premium', 2020, 'GASOLINE', 'Đen', 'Nâu da bò', 7, 'SUV', 140000, 'INDIVIDUAL', 485, 499],
  ['VINFAST', 'VF 3', 'Mua pin', 2025, 'ELECTRIC', 'Hồng', 'Hồng', 5, 'HATCHBACK', 15000, 'INDIVIDUAL', 260, 275],
  ['MERCEDES-BENZ', 'C-Class', 'C300 AMG', 2017, 'GASOLINE', 'Đỏ', 'Đen', 5, 'SEDAN', 65000, 'INDIVIDUAL', 650, 679],
  ['MERCEDES-BENZ', 'C-Class', 'C250 Exclusive', 2017, 'GASOLINE', 'Trắng', 'Đen', 5, 'SEDAN', 110000, 'INDIVIDUAL', 590, 615],
  ['KIA', 'Sonet', 'Premium', 2024, 'GASOLINE', 'Trắng', 'Đen', 5, 'SUV', 30000, 'INDIVIDUAL', 535, 555],
];

const DAY_MS = 24 * 60 * 60 * 1000;
const NEGOTIATION_DROP = 5 * MILLION;

// Fake floor price: 10-20M above the buy price, but never above (list price - 5M),
// which is how far a haggling customer can push the price down.
const buildFloorPrice = (buyPrice, listPrice, seq) => {
  const aboveBuy = buyPrice + (10 + ((seq * 7) % 11)) * MILLION;
  const belowList = listPrice - NEGOTIATION_DROP;
  return Math.max(buyPrice, Math.min(aboveBuy, belowList));
};

// Older or high-mileage cars are the ones that get haggled down once.
const isMarkdownCandidate = (year, mileage) => year <= 2020 || mileage >= 100000;

// FRESH < 30 days, SLOW < 90 days, otherwise STAGNANT (mock thresholds for seed data only)
const agingCategoryOf = (days) => {
  if (days < 30) {
    return 'FRESH';
  }
  return days < 90 ? 'SLOW' : 'STAGNANT';
};

const buildCarData = (row, index, adminId, now) => {
  const [make, model, variant, year, fuelType, color, interiorColor, seats, bodyType,
    mileage, ownerType, buyPrice, listPrice] = row;
  const seq = index + 1;
  const listPriceVnd = listPrice * MILLION;
  const buyPriceVnd = buyPrice * MILLION;
  const markdown = isMarkdownCandidate(year, mileage);
  const daysInStock = 10 + ((seq * 37) % 110);
  const listedDate = new Date(now.getTime() - daysInStock * DAY_MS);
  const dropDate = new Date(listedDate.getTime() + Math.min(7, daysInStock - 1) * DAY_MS);

  // Same shape carService writes: initial intake price, then every later price change
  const priceHistory = markdown
    ? [
      { price: listPriceVnd + NEGOTIATION_DROP, changedBy: adminId, changedAt: listedDate, reason: 'Initial intake price' },
      { price: listPriceVnd, changedBy: adminId, changedAt: dropDate, reason: 'Customer negotiation - price reduced' },
    ]
    : [{ price: listPriceVnd, changedBy: adminId, changedAt: listedDate, reason: 'Initial intake price' }];

  return {
    // Fake but format-valid identifiers (the list has neither VIN nor plate)
    vin:          `TCSEED00000${String(seq).padStart(6, '0')}`,
    licensePlate: `30K-${100 + seq}.${String(seq).padStart(2, '0')}`,
    make,
    model,
    variant,
    year,
    bodyType,
    fuelType,
    mileage,
    ownerType,
    price:         listPriceVnd,
    listedPrice:   listPriceVnd,
    originalPrice: buyPriceVnd,
    floorPrice:    buildFloorPrice(buyPriceVnd, listPriceVnd, seq),
    priceDropCount: markdown ? 1 : 0,
    listedDate,
    daysInStock,
    agingCategory: agingCategoryOf(daysInStock),
    priceHistory,
    status:        CarStatus.AVAILABLE,
    specifications: { color, interiorColor, numberOfSeats: seats },
    createdBy:     adminId,
    // Kept for the markdown record created after the car is saved
    markdown: markdown
      ? { oldPrice: listPriceVnd + NEGOTIATION_DROP, newPrice: listPriceVnd, createdAt: dropDate }
      : null,
  };
};

const ensureAdmin = async (apply) => {
  let admin = await User.findOne({ roleName: Roles.ADMIN, isActive: true }).select('_id').lean();
  if (admin || !apply) {
    return admin;
  }
  await Role.seedDefaultRoles();
  await seedAdminAccount();
  admin = await User.findOne({ roleName: Roles.ADMIN, isActive: true }).select('_id').lean();
  return admin;
};

const run = async () => {
  const apply = process.argv.includes('--apply');
  const now = new Date();

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    autoIndex:  false,
    autoCreate: false,
  });
  const { host, name } = mongoose.connection;
  console.log(`Target: ${host} / db: ${name} (${apply ? 'APPLY' : 'DRY RUN'})`);

  try {
    const admin = await ensureAdmin(apply);
    if (!admin && apply) {
      console.error('Could not create or find an ADMIN user. Nothing written.');
      process.exitCode = 1;
      return;
    }
    if (!admin) {
      console.log('No ADMIN user yet: --apply will create one (ADMIN_EMAIL / ADMIN_PASSWORD or defaults).');
    }

    const adminId = admin ? admin._id : null;
    const docs = CAR_ROWS.map((row, i) => buildCarData(row, i, adminId, now));
    const existing = new Set(
      (await Car.find({ vin: { $in: docs.map((d) => d.vin) } }).select('vin').lean()).map((c) => c.vin),
    );
    const toInsert = docs.filter((d) => !existing.has(d.vin));
    console.log(`Cars in list: ${docs.length} | already in DB: ${existing.size} | to insert: ${toInsert.length}`);
    console.log(`Markdown records (pricehistories) to insert: ${toInsert.filter((d) => d.markdown).length}`);

    if (!apply) {
      toInsert.forEach((d) =>
        console.log(`  ${d.make} ${d.model} ${d.variant} ${d.year} | ${d.mileage} km | list ${d.price.toLocaleString('vi-VN')} | floor ${d.floorPrice.toLocaleString('vi-VN')} | ${d.daysInStock}d ${d.agingCategory}${d.markdown ? ' | markdown -5tr' : ''}`));
      console.log('Dry run only. Re-run with --apply to insert.');
      return;
    }

    // Sequential on purpose: generateVehicleCode reads the latest code from the DB
    for (const data of toInsert) {
      const { markdown, ...carData } = data;
      const vehicleCode = await generateVehicleCode(Car);
      const car = await Car.create({ ...carData, vehicleCode });

      if (markdown) {
        await PriceHistory.create({
          carId:              car._id,
          changedBy:          adminId,
          oldPrice:           markdown.oldPrice,
          newPrice:           markdown.newPrice,
          dropAmount:         markdown.oldPrice - markdown.newPrice,
          reason:             'Customer negotiation - price reduced',
          notifiedLeadsCount: 0,
          createdAt:          markdown.createdAt,
        });
      }
    }
    console.log(`Inserted ${toInsert.length} cars.`);
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error('Car seeder failed:', error.message);
  process.exit(1);
});
