import mongoose from 'mongoose';
import { InterestType } from './extendedEnums.js';

const { Schema } = mongoose;

const LeadVehicleInterestSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    carId: { type: Schema.Types.ObjectId, ref: 'Car', required: true },
    interestType: { type: String, enum: Object.values(InterestType), required: true },
    isShortlisted: { type: Boolean, default: false },
    firstInterestedAt: { type: Date, default: Date.now },
    lastInterestedAt: { type: Date, default: Date.now },
  },
  { collection: 'lead_vehicle_interests', timestamps: false },
);

LeadVehicleInterestSchema.index({ leadId: 1, carId: 1 }, { unique: true });
LeadVehicleInterestSchema.index({ carId: 1, interestType: 1 });

export default mongoose.model('LeadVehicleInterest', LeadVehicleInterestSchema);
