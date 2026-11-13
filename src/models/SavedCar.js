/**
 * @file SavedCar.js
 * @description Saved Cars Wishlist & Price Drop Alerts model for logged-in customers.
 *
 * Key design decisions:
 * - Persisted strictly for authenticated accounts; guest wishlists remain in
 *   browser localStorage until synced after login/signup.
 * - `priceAtSave` snapshots the server-side Car.price at the moment of saving
 *   (never trusted from client input).
 * - Compound unique index `{ user: 1, car: 1 }` prevents duplicate saves.
 * - `priceAlerts` stores per-user in-app price drop notifications alongside
 *   email delivery status.
 */

import mongoose from 'mongoose';

const PriceDropAlertSchema = new mongoose.Schema(
  {
    oldPrice: {
      type: Number,
      required: [true, 'Old price is required.'],
      min: [0, 'Old price must be non-negative.'],
    },
    newPrice: {
      type: Number,
      required: [true, 'New price is required.'],
      min: [0, 'New price must be non-negative.'],
    },
    dropAmount: {
      type: Number,
      required: [true, 'Drop amount is required.'],
      min: [0, 'Drop amount must be non-negative.'],
    },
    notifiedAt: {
      type: Date,
      default: () => new Date(),
    },
    emailSent: {
      type: Boolean,
      default: false,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true, versionKey: false }
);

const SavedCarSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required.'],
    },

    car: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Car',
      required: [true, 'Car reference is required.'],
    },

    priceAtSave: {
      type: Number,
      required: [true, 'Price at save time is required.'],
      min: [0, 'Price at save must be non-negative.'],
    },

    priceAlertEnabled: {
      type: Boolean,
      default: true,
    },

    priceAlerts: {
      type: [PriceDropAlertSchema],
      default: [],
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'saved_cars',
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
SavedCarSchema.index({ user: 1, car: 1 }, { unique: true });
SavedCarSchema.index({ user: 1, createdAt: -1 });
SavedCarSchema.index({ car: 1, priceAlertEnabled: 1 });

const SavedCar = mongoose.model('SavedCar', SavedCarSchema);
export default SavedCar;

