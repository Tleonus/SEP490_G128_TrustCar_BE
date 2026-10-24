import mongoose from 'mongoose';
import { ConsentState } from './extendedEnums.js';

const { Schema } = mongoose;

const VisitorSessionSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    startedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    consentState: { type: String, enum: Object.values(ConsentState), default: ConsentState.PENDING },
  },
  { collection: 'visitor_sessions', timestamps: false },
);

export default mongoose.model('VisitorSession', VisitorSessionSchema);
