// src/models/PriceHistory.js
/**
 * @file PriceHistory.js
 * @description Records each price change (markdown) event for a car.
 */

import mongoose from 'mongoose';

const PriceHistorySchema = new mongoose.Schema(
  {
    carId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Car',
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    oldPrice: {
      type: Number,
      required: true,
    },
    newPrice: {
      type: Number,
      required: true,
    },
    dropAmount: {
      type: Number,
      required: true,
    },
    reason: {
      type: String,
      trim: true,
      default: null,
    },
    notifiedLeadsCount: {
      type: Number,
      default: 0,
    },
    createdAt: {
      type: Date,
      default: () => new Date(),
    },
    // Optional audit fields
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'pricehistories',
  }
);

// Indexes for fast queries
PriceHistorySchema.index({ carId: 1 });
PriceHistorySchema.index({ changedBy: 1 });
PriceHistorySchema.index({ createdAt: -1 });

const PriceHistory = mongoose.model('PriceHistory', PriceHistorySchema);
export default PriceHistory;
