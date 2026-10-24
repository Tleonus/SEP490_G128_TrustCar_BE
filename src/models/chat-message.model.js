import mongoose from 'mongoose';
import { SenderType } from './extendedEnums.js';

const { Schema } = mongoose;

const ChatMessageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'ChatConversation', required: true },
    senderType: { type: String, enum: Object.values(SenderType), required: true },
    senderUserId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      required() {
        return this.senderType === SenderType.STAFF;
      },
    },
    content: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
  },
  { collection: 'chat_messages', timestamps: false },
);

ChatMessageSchema.index({ conversationId: 1, sentAt: 1 });

export default mongoose.model('ChatMessage', ChatMessageSchema);
