import mongoose from 'mongoose';
import { RecordStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const ValuationRuleSchema = new Schema(
  {
    modelId: { type: Schema.Types.ObjectId, ref: 'CarModel', required: true },
    referenceNewCarPrice: { type: Number, required: true, min: 0 },
    annualDepreciationRate: { type: Number, required: true, min: 0, max: 1 },
    mileageDeductionPer10000Km: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, required: true },
    status: { type: String, enum: Object.values(RecordStatus), default: RecordStatus.ACTIVE },
  },
  { collection: 'valuation_rules', timestamps: true },
);

ValuationRuleSchema.index({ modelId: 1, effectiveFrom: -1 });

export default mongoose.model('ValuationRule', ValuationRuleSchema);
