import mongoose from 'mongoose';

const { Schema } = mongoose;

const PermissionSchema = new Schema(
  {
    permissionCode: { type: String, required: true, unique: true, trim: true },
    permissionName: { type: String, required: true },
    module: { type: String, required: true, index: true },
  },
  { collection: 'permissions', timestamps: true },
);

export default mongoose.model('Permission', PermissionSchema);
