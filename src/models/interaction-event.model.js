import mongoose from 'mongoose';

const { Schema } = mongoose;

const InteractionEventSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'VisitorSession', required: true },
    carId: { type: Schema.Types.ObjectId, ref: 'Car', default: null },
    recommendationItemId: { type: Schema.Types.ObjectId, default: null },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    eventType: { type: String, required: true },
    occurredAt: { type: Date, default: Date.now },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'interaction_events', timestamps: false },
);

InteractionEventSchema.index({ sessionId: 1, occurredAt: 1 });
InteractionEventSchema.index({ carId: 1, eventType: 1, occurredAt: -1 });
InteractionEventSchema.index({ leadId: 1, occurredAt: -1 });

export default mongoose.model('InteractionEvent', InteractionEventSchema);
