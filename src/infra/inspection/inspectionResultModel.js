import mongoose from 'mongoose';
import { INSPECTION_LIMITS } from '../../config/inspectionChecklist.js';
import { InspectionResult as Outcome } from '../../domain/inspection/criteria.js';
import { criterionKeyMaxLength, criterionKeyPattern } from '../../domain/inspection/criterionDefinition.js';

const { Schema } = mongoose;

const inspectionResultSchema = new Schema({
  inspectionId: { type: Schema.Types.ObjectId, ref: 'InspectionRecord', required: true, immutable: true },
  criterionId: {
    type: String, required: true, match: criterionKeyPattern, maxlength: criterionKeyMaxLength, immutable: true,
  },
  outcome: { type: String, required: true, enum: Object.values(Outcome) },
  note: { type: String, trim: true, maxlength: INSPECTION_LIMITS.NOTE_MAX_LENGTH, default: '' },
  evidenceImages: {
    type: [{ type: String, maxlength: 500, match: /^https:\/\//i }],
    default: [],
    validate: (images) => Array.isArray(images) && images.length <= INSPECTION_LIMITS.ITEM_PHOTOS_MAX,
  },
}, { collection: 'inspection_results', versionKey: false, autoCreate: false, autoIndex: false });

inspectionResultSchema.index({ inspectionId: 1, criterionId: 1 }, { unique: true });

export default mongoose.model('InspectionResult', inspectionResultSchema);
