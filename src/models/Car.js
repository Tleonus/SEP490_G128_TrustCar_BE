/**
 * @file Car.js
 * @description Vehicle entity model – the central domain object of the TrustCar platform.
 *
 * Key design decisions:
 * - vehicleCode (TC-YYYY-NNNN): auto-generated unique code, immutable after creation (GBR-13).
 * - VIN: unique across all non-DELISTED records (GBR-04).
 * - licensePlate: unique across active-inventory statuses (GBR-08).
 * - status: enforced via state machine in carService.js (GBR-05).
 * - SOLD vehicles become read-only (GBR-06, enforced in service layer).
 * - priceHistory: append-only subdocument array (GBR-07).
 * - mileage cannot decrease (GBR-09, enforced in service layer).
 * - images: max 20, exactly one isPrimary (GBR-14, GBR-15).
 */

import mongoose from 'mongoose';
import {
  CarStatus,
  FuelType,
  Transmission,
  DriveType,
  BodyType,
} from '../constants/appConstants.js';

// ── Subdocument: Price History Entry (Append-Only) ─────────────────────────
// Ref: GBR-07
const PriceHistorySchema = new mongoose.Schema(
  {
    price: {
      type:     Number,
      required: true,
      min:      [0, 'Price must be non-negative.'],
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'User',
    },
    changedAt: {
      type:    Date,
      default: () => new Date(),
    },
    reason: {
      type:      String,
      trim:      true,
      maxlength: 500,
      default:   null,
    },
  },
  { _id: true, versionKey: false }
);

// ── Subdocument: Vehicle Image ─────────────────────────────────────────────
const VehicleImageSchema = new mongoose.Schema(
  {
    url: {
      type:     String,
      required: true,
    },
    publicId: {
      type:     String, // Cloudinary public_id for deletion
      required: true,
    },
    isPrimary: {
      type:    Boolean,
      default: false,
    },
    caption: {
      type:      String,
      trim:      true,
      maxlength: 200,
      default:   null,
    },
    uploadedAt: {
      type:    Date,
      default: () => new Date(),
    },
  },
  { _id: true, versionKey: false }
);

// ── Subdocument: Vehicle Specifications (flexible) ─────────────────────────
const SpecificationsSchema = new mongoose.Schema(
  {
    engineDisplacementCC: { type: Number, default: null },
    engineCylinders:      { type: Number, default: null },
    horsePower:           { type: Number, default: null },
    torqueNm:             { type: Number, default: null },
    numberOfDoors:        { type: Number, default: null },
    numberOfSeats:        { type: Number, default: null },
    fuelTankLiters:       { type: Number, default: null },
    fuelConsumption:      { type: Number, default: null }, // L/100km (mixed)
    safetyRating:         { type: String, default: null }, // e.g., "5-star ASEAN NCAP"
    features:             { type: [String], default: [] }, // e.g., ['Sunroof', 'Leather seats']
    color:                { type: String, trim: true, default: null },
    interiorColor:        { type: String, trim: true, default: null },
    originCountry:        { type: String, trim: true, default: null }, // e.g., 'Japan', 'Thailand'
    importType:           {
      type: String,
      enum: ['CBU', 'CKD', 'LOCAL', null],
      default: null,
    },
  },
  { _id: false, versionKey: false }
);

// ── Main Car Schema ────────────────────────────────────────────────────────
const CarSchema = new mongoose.Schema(
  {
    // ── Unique Identifiers ─────────────────────────────────────────────
    vehicleCode: {
      type:     String,
      unique:   true,
      trim:     true,
      // Set by carService.js using codeGenerator.generateVehicleCode()
      // Format: TC-YYYY-NNNN (e.g., TC-2024-0001) – GBR-13
    },

    vin: {
      type:      String,
      required:  [true, 'VIN is required.'],
      unique:    true,
      trim:      true,
      uppercase: true,
      minlength: [17, 'VIN must be exactly 17 characters.'],
      maxlength: [17, 'VIN must be exactly 17 characters.'],
      match:     [/^[A-HJ-NPR-Z0-9]{17}$/, 'VIN contains invalid characters.'],
      // Uniqueness across all non-DELISTED records enforced in service (GBR-04)
    },

    licensePlate: {
      type:      String,
      required:  [true, 'License plate is required.'],
      trim:      true,
      uppercase: true,
      maxlength: 15,
      // Active-inventory uniqueness enforced in service (GBR-08)
    },

    // ── Make / Model Reference ─────────────────────────────────────────
    carModelRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref:  'CarModel',
      // Optional reference – staff may also enter free-text fields below
    },

    make: {
      type:      String,
      required:  [true, 'Vehicle make is required.'],
      trim:      true,
      uppercase: true,
      maxlength: 60,
    },

    model: {
      type:      String,
      required:  [true, 'Vehicle model is required.'],
      trim:      true,
      maxlength: 100,
    },

    variant: {
      type:      String,
      trim:      true,
      maxlength: 100,
      default:   null,
    },

    // ── Core Specs ────────────────────────────────────────────────────
    year: {
      type:     Number,
      required: [true, 'Production year is required.'],
      // Range validated at DTO layer (GBR-10)
    },

    bodyType: {
      type:    String,
      enum:    Object.values(BodyType),
      default: null,
    },

    fuelType: {
      type:    String,
      enum:    Object.values(FuelType),
      default: null,
    },

    transmission: {
      type:    String,
      enum:    Object.values(Transmission),
      default: null,
    },

    driveType: {
      type:    String,
      enum:    Object.values(DriveType),
      default: null,
    },

    mileage: {
      type:    Number,
      default: 0,
      min:     [0, 'Mileage cannot be negative.'],
      // Cannot decrease once set (GBR-09, enforced in service)
    },

    specifications: {
      type:    SpecificationsSchema,
      default: () => ({}),
    },

    // ── Pricing ───────────────────────────────────────────────────────
    // ── Pricing ───────────────────────────────────────────────────────
    price: {
      type:     Number,
      required: [true, 'Price is required.'],
      min:      [0, 'Price cannot be negative.'],
    },
    inventoryType: {
      type: String,
      enum: ['OWNED', 'CONSIGNMENT'],
      default: 'OWNED',
    },
    floorPrice: {
      type: Number,
      default: 0,
    },
    originalPrice: {
      type: Number,
      default: 0,
    },
    listedPrice: {
      type: Number,
      default: 0,
    },
    priceDropCount: {
      type: Number,
      default: 0,
    },
    listedDate: {
      type: Date,
      default: () => new Date(),
    },
    daysInStock: {
      type: Number,
      default: 0,
    },
    agingCategory: {
      type: String,
      enum: ['FRESH', 'SLOW', 'STAGNANT'],
      default: 'FRESH',
    },
    // Chủ đứng tên đăng ký: công ty (CTY) hay cá nhân (CN)
    ownerType: {
      type: String,
      enum: ['COMPANY', 'INDIVIDUAL'],
      default: 'INDIVIDUAL',
    },

    priceHistory: {
      type:    [PriceHistorySchema],
      default: [],
      // Append-only – no DELETE/UPDATE via service (GBR-07)
    },

    // ── Lifecycle Status ──────────────────────────────────────────────
    status: {
      type:    String,
      enum:    {
        values:  Object.values(CarStatus),
        message: 'Status must be one of: ' + Object.values(CarStatus).join(', '),
      },
      default: CarStatus.INCOMING,
      index:   true,
    },

    // ── Media ─────────────────────────────────────────────────────────
    images: {
      type:     [VehicleImageSchema],
      default:  [],
      validate: {
        validator: (arr) => arr.length <= 20,
        message:   'A vehicle cannot have more than 20 images.',
      },
      // Exactly one isPrimary enforced in service (GBR-14)
    },

    // ── Condition & Description ────────────────────────────────────────
    description: {
      type:      String,
      trim:      true,
      maxlength: [5000, 'Description cannot exceed 5000 characters.'],
      default:   null,
    },

    conditionGrade: {
      type: String,
      enum: ['A', 'B', 'C', 'D', null],
      default: null,
      // A = Excellent, B = Good, C = Fair, D = Poor
    },

    registrationExpiry: {
      type:    Date,
      default: null,
    },

    // ── Audit / Ownership ─────────────────────────────────────────────
    createdBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },

    updatedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },

    statusChangedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },

    statusChangedAt: {
      type:    Date,
      default: null,
    },

    soldAt: {
      type:    Date,
      default: null,
    },

    isActive: {
      type:    Boolean,
      default: true,
      // false = soft-deleted (GBR-25)
    },

    // ── Internal Notes ────────────────────────────────────────────────
    internalNotes: {
      type:      String,
      trim:      true,
      maxlength: 2000,
      default:   null,
      // Not exposed in public API responses
    },
  },
  {
    timestamps:  true,
    versionKey:  false,
    collection:  'cars',
    toJSON:  { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
CarSchema.index({ licensePlate: 1 });
CarSchema.index({ make: 1, model: 1 });
CarSchema.index({ year: 1 });
CarSchema.index({ price: 1 });
CarSchema.index({ mileage: 1 });
CarSchema.index({ status: 1, isActive: 1 });
CarSchema.index({ make: 1, status: 1, price: 1 }); // Public filter compound index

// ── Virtual: primaryImage ─────────────────────────────────────────────────
CarSchema.virtual('primaryImage').get(function () {
  if (!this.images || this.images.length === 0) return null;
  return this.images.find((img) => img.isPrimary) || this.images[0];
});

const Car = mongoose.model('Car', CarSchema);
export default Car;
