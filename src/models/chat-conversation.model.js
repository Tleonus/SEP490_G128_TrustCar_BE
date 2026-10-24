import mongoose from 'mongoose';
import { ConversationStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const ChatConversationSchema = new Schema(
  {
    conversationCode: { type: String, required: true, unique: true, trim: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
    assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    startedAt: { type: Date, default: Date.now },
    lastMessageAt: { type: Date, default: null },
    contactName: { type: String, default: null },
    contactPhone: { type: String, default: null },
    summary: { type: String, default: null },
    summaryUpdatedAt: { type: Date, default: null },
    lastSummarizedMessageAt: { type: Date, default: null },
    status: { type: String, enum: Object.values(ConversationStatus), default: ConversationStatus.OPEN },
  },
  { collection: 'chat_conversations', timestamps: true },
);

ChatConversationSchema.index({ assignedUserId: 1, status: 1, lastMessageAt: -1 });

export default mongoose.model('ChatConversation', ChatConversationSchema);
