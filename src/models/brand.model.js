import mongoose from 'mongoose';
import { RecordStatus } from './extendedEnums.js';

const BrandSchema = new mongoose.Schema(
  {
    brandName: { type: String, required: true, unique: true, trim: true },
    logo: { type: String, default: null },
    status: { type: String, enum: Object.values(RecordStatus), default: RecordStatus.ACTIVE },
  },
  { collection: 'brands', timestamps: true },
);

export default mongoose.model('Brand', BrandSchema);
