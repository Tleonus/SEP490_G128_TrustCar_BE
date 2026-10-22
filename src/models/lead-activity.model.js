import mongoose from 'mongoose';

const { Schema } = mongoose;

const LeadActivitySchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    activityType: { type: String, required: true },
    content: { type: String, required: true },
    occurredAt: { type: Date, default: Date.now },
  },
  { collection: 'lead_activities', timestamps: false },
);

LeadActivitySchema.index({ leadId: 1, occurredAt: -1 });

export default mongoose.model('LeadActivity', LeadActivitySchema);
