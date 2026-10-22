import mongoose from 'mongoose';
import { RecordStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const SystemSettingSchema = new Schema(
  {
    settingKey: { type: String, required: true, unique: true, trim: true },
    value: { type: Schema.Types.Mixed, required: true },
    groupName: { type: String, required: true, index: true },
    description: { type: String, default: null },
    status: { type: String, enum: Object.values(RecordStatus), default: RecordStatus.ACTIVE },
    updatedByUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'system_settings', timestamps: true },
);

export default mongoose.model('SystemSetting', SystemSettingSchema);
