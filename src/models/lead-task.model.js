import mongoose from 'mongoose';
import { LeadTaskStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const LeadTaskSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    taskType: { type: String, required: true },
    title: { type: String, required: true },
    dueAt: { type: Date, default: null },
    status: { type: String, enum: Object.values(LeadTaskStatus), default: LeadTaskStatus.PENDING },
    completedAt: { type: Date, default: null },
    resultNote: { type: String, default: null },
  },
  { collection: 'lead_tasks', timestamps: true },
);

LeadTaskSchema.index({ assignedUserId: 1, status: 1, dueAt: 1 });

export default mongoose.model('LeadTask', LeadTaskSchema);
