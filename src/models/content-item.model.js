import mongoose from 'mongoose';
import { ContentStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const ContentItemSchema = new Schema(
  {
    authorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: null },
    image: { type: String, default: null },
    linkUrl: { type: String, default: null },
    displayOrder: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
    status: { type: String, enum: Object.values(ContentStatus), default: ContentStatus.DRAFT },
  },
  { collection: 'content_items', timestamps: true },
);

ContentItemSchema.index({ type: 1, status: 1, displayOrder: 1 });

export default mongoose.model('ContentItem', ContentItemSchema);
