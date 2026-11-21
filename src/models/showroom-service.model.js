/**
 * @file showroom-service.model.js
 * @description Package of showroom services sold à la carte (wash, polish,
 * ceramic coat, undercoat, interior detail, general inspection).
 *
 * KAN-96:
 *  - `code` is the stable business identifier (uppercase slug) used by the
 *    seeder and snapshotted on every service appointment. Immutable once set:
 *    the UPDATE route rejects attempts to change it.
 *  - `status` is the soft-delete flag — DELETE in the API flips it to INACTIVE
 *    instead of removing the document so historical appointments can still
 *    resolve `Appointment.service`.
 */

import mongoose from 'mongoose';
import { RecordStatus } from './extendedEnums.js';

const { Schema } = mongoose;

const ShowroomServiceSchema = new Schema(
  {
    code: {
      type:     String,
      required: true,
      trim:     true,
      uppercase: true,
      match:    [/^[A-Z0-9_]{3,40}$/, 'Service code must be 3-40 uppercase letters, digits or underscores.'],
    },
    serviceName: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: null, maxlength: 2000 },
    estimatedDuration: { type: Number, required: true, min: 15, max: 480 }, // minutes
    referencePrice:    { type: Number, required: true, min: 0, max: 500_000_000 }, // VND
    status: {
      type:    String,
      enum:    Object.values(RecordStatus),
      default: RecordStatus.ACTIVE,
      index:   true,
    },

    // Audit
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'showroom_services', timestamps: true, versionKey: false },
);

ShowroomServiceSchema.index({ code: 1 }, { unique: true, name: 'uniq_service_code' });
ShowroomServiceSchema.index({ status: 1, serviceName: 1 });

export default mongoose.model('ShowroomService', ShowroomServiceSchema);
