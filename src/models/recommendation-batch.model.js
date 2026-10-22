import mongoose from 'mongoose';

const { Schema } = mongoose;

const RecommendationItemSchema = new Schema({
  carId: { type: Schema.Types.ObjectId, ref: 'Car', required: true },
  rankPosition: { type: Number, required: true, min: 1 },
  rankingScore: { type: Number, required: true },
  reasonCodes: { type: [String], default: [] },
  displayedAt: { type: Date, default: null },
});

const RecommendationBatchSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    sessionId: { type: Schema.Types.ObjectId, ref: 'VisitorSession', default: null },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    algorithmType: { type: String, required: true },
    modelVersion: { type: String, default: null },
    items: { type: [RecommendationItemSchema], default: [] },
  },
  { collection: 'recommendation_batches', timestamps: { createdAt: true, updatedAt: false } },
);

RecommendationBatchSchema.pre('validate', function () {
  if (!this.customerId && !this.sessionId && !this.leadId) {
    throw new Error('RecommendationBatch requires customerId, sessionId, or leadId');
  }
});

RecommendationBatchSchema.index({ customerId: 1, createdAt: -1 });
RecommendationBatchSchema.index({ sessionId: 1, createdAt: -1 });
RecommendationBatchSchema.index({ leadId: 1 });
RecommendationBatchSchema.index({ 'items._id': 1 });

export default mongoose.model('RecommendationBatch', RecommendationBatchSchema);
