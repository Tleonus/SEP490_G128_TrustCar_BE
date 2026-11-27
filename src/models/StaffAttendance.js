/**
 * @file StaffAttendance.js
 * @description Daily attendance of sales staff (who goes on test drives).
 *
 * Every active SALES_STAFF user counts as present on every day by default; a record with
 * `present: false` takes them out for that Vietnam day, so the test-drive slots of that day
 * hold fewer visits. A record with `present: true` only remembers who ticked them back in.
 * Only today and later days can be changed (see staffAttendanceService.js).
 */

import mongoose from 'mongoose';

const StaffAttendanceSchema = new mongoose.Schema(
  {
    // Vietnam calendar day, `YYYY-MM-DD`.
    date: {
      type:     String,
      required: true,
      match:    /^\d{4}-\d{2}-\d{2}$/,
    },
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    present: {
      type:     Boolean,
      required: true,
    },
    markedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     'User',
      default: null,
    },
    markedAt: {
      type:    Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'staff_attendances',
  },
);

StaffAttendanceSchema.index({ date: 1, user: 1 }, { unique: true, name: 'uniq_attendance_date_user' });

const StaffAttendance = mongoose.model('StaffAttendance', StaffAttendanceSchema);
export default StaffAttendance;
