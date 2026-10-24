import mongoose from 'mongoose';
import { RecordStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const ShowroomServiceSchema = new Schema(
  {
    serviceName: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    estimatedDuration: { type: Number, required: true, min: 0 },
    referencePrice: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(RecordStatus), default: RecordStatus.ACTIVE },
  },
  { collection: 'showroom_services', timestamps: true },
);

export default mongoose.model('ShowroomService', ShowroomServiceSchema);
