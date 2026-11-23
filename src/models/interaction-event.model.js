import mongoose from 'mongoose';
import { TRACKABLE_EVENT_TYPES } from '../constants/leadScoringConstants.js';

const { Schema } = mongoose;

/** KAN-97: `LEAD_ENQUIRY` để dành cho ghi event khi khách gửi form liên hệ. */
const EVENT_TYPES = [...TRACKABLE_EVENT_TYPES, 'LEAD_ENQUIRY'];

const InteractionEventSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'VisitorSession', required: true },
    carId: { type: Schema.Types.ObjectId, ref: 'Car', default: null },
    recommendationItemId: { type: Schema.Types.ObjectId, default: null },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    eventType: {
      type: String,
      required: true,
      enum: { values: EVENT_TYPES, message: 'Unknown interaction event type.' },
    },
    occurredAt: { type: Date, default: Date.now },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { collection: 'interaction_events', timestamps: false },
);

InteractionEventSchema.index({ sessionId: 1, occurredAt: 1 });
InteractionEventSchema.index({ carId: 1, eventType: 1, occurredAt: -1 });
InteractionEventSchema.index({ leadId: 1, occurredAt: -1 });

export default mongoose.model('InteractionEvent', InteractionEventSchema);
