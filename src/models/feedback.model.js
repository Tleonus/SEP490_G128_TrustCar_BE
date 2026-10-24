import mongoose from 'mongoose';
import { FeedbackStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const FeedbackSchema = new Schema(
  {
    customerName: { type: String, required: true, trim: true },
    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    content: { type: String, required: true },
    carId: { type: Schema.Types.ObjectId, ref: 'Car', default: null, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    status: { type: String, enum: Object.values(FeedbackStatus), default: FeedbackStatus.PENDING },
    reviewedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { collection: 'feedbacks', timestamps: true },
);

FeedbackSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('Feedback', FeedbackSchema);
