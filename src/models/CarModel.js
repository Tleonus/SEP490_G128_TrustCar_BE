/**
 * @file CarModel.js
 * @description Vehicle brand, model line, and body type catalogue.
 * Decoupled from the Car entity so multiple Car records can reference the same make/model
 * without data duplication.
 *
 * This is not to be confused with the Car mongoose model (Car.js).
 * This collection stores the *catalogue* of make/model combinations available for intake.
 */

import mongoose from 'mongoose';
import { BodyType } from '../constants/appConstants.js';

const CarModelSchema = new mongoose.Schema(
  {
    // ── Make / Brand ──────────────────────────────────────────────────────
    make: {
      type:      String,
      required:  [true, 'Vehicle make (brand) is required.'],
      trim:      true,
      uppercase: true,
      maxlength: 60,
      // e.g., TOYOTA, HONDA, FORD, VINFAST
    },

    // ── Model Line ────────────────────────────────────────────────────────
    model: {
      type:      String,
      required:  [true, 'Vehicle model is required.'],
      trim:      true,
      maxlength: 100,
      // e.g., Camry, Civic, Ranger, VF8
    },

    // ── Variant / Trim Level ──────────────────────────────────────────────
    variant: {
      type:      String,
      trim:      true,
      maxlength: 100,
      default:   null,
      // e.g., 2.5Q, 1.5G, Sport, Luxury
    },

    // ── Body Classification ───────────────────────────────────────────────
    bodyType: {
      type:  String,
      enum:  {
        values:  Object.values(BodyType),
        message: 'Body type must be one of: ' + Object.values(BodyType).join(', '),
      },
      default: null,
    },

    // ── Production Years Range ────────────────────────────────────────────
    productionYearStart: {
      type:    Number,
      integer: true,
      min:     1990,
    },

    productionYearEnd: {
      type:    Number,
      integer: true,
      default: null, // null = still in production
    },

    // ── Metadata ──────────────────────────────────────────────────────────
    logoUrl: {
      type:    String,
      default: null,
    },

    isActive: {
      type:    Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'car_models',
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
CarModelSchema.index({ make: 1, model: 1, variant: 1 }, { unique: true });
CarModelSchema.index({ make: 1 });
CarModelSchema.index({ bodyType: 1 });
CarModelSchema.index({ isActive: 1 });

// ── Compound unique on make + model + variant ──────────────────────────────
CarModelSchema.pre('save', function (next) {
  if (this.productionYearEnd && this.productionYearStart) {
    if (this.productionYearEnd < this.productionYearStart) {
      return next(new Error('productionYearEnd cannot be before productionYearStart.'));
    }
  }
  next();
});

const CarModelCatalogue = mongoose.model('CarModel', CarModelSchema);
export default CarModelCatalogue;
