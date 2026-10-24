import mongoose from 'mongoose';
import { SaleStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const SaleRecordSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
    carId: { type: Schema.Types.ObjectId, ref: 'Car', required: true },
    recordedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    saleDate: { type: Date, required: true },
    finalPrice: { type: Number, required: true, min: 0 },
    handoverDate: { type: Date, default: null },
    note: { type: String, default: null },
    voidReason: { type: String, default: null },
    status: { type: String, enum: Object.values(SaleStatus), default: SaleStatus.COMPLETED },
  },
  { collection: 'sale_records', timestamps: true },
);

SaleRecordSchema.index({ carId: 1 }, { unique: true, partialFilterExpression: { status: SaleStatus.COMPLETED } });
SaleRecordSchema.index({ saleDate: -1 });

export default mongoose.model('SaleRecord', SaleRecordSchema);
