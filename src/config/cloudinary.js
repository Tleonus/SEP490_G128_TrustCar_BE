/**
 * @file cloudinary.js
 * @description Singleton Cloudinary v2 SDK client configuration.
 *
 * Pattern: Singleton – the cloudinary instance is configured once and the
 * configured client + upload helper are exported for use across the application.
 *
 * Features:
 * - Centralised credential management via environment variables.
 * - Reusable uploadToCloudinary() helper with pre-configured folder & preset.
 * - deleteFromCloudinary() utility for image cleanup on car record updates.
 */

import { v2 as cloudinary } from 'cloudinary';

/**
 * Configures the Cloudinary SDK singleton with credentials from env vars.
 * Called once during app startup (app.js).
 */
export const configureCloudinary = () => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.warn('⚠️   Cloudinary: Missing credentials – image uploads will fail.');
    return;
  }

  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key:    CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure:     true, // Always use HTTPS URLs
  });

  console.log(`✅  Cloudinary configured (cloud: ${CLOUDINARY_CLOUD_NAME})`);
};

/**
 * Uploads a file buffer to Cloudinary under the TrustCar vehicle folder.
 * Enforces JPG/PNG/WebP only and 5 MB max via Multer (uploadMiddleware.js),
 * but also applies server-side format validation here as a defence-in-depth
 * measure (Ref: MSG32, MSG33).
 *
 * @param {Buffer} fileBuffer   - The raw file buffer from Multer memoryStorage.
 * @param {string} [folder]     - Sub-folder path within the Cloudinary project.
 * @param {string} [publicId]   - Optional explicit public_id (for replacement).
 * @returns {Promise<{url: string, publicId: string, width: number, height: number}>}
 */
export const uploadToCloudinary = (fileBuffer, folder, publicId) => {
  const targetFolder = folder || process.env.CLOUDINARY_FOLDER || 'trustcar/vehicles';
  const preset       = process.env.CLOUDINARY_UPLOAD_PRESET || 'trustcar_vehicles';

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder:         targetFolder,
      upload_preset:  preset,
      resource_type:  'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
      transformation: [
        { quality: 'auto:good', fetch_format: 'auto' }, // Auto-optimize
        { width: 1920, height: 1280, crop: 'limit' },   // Cap max dimensions
      ],
    };

    if (publicId) uploadOptions.public_id = publicId;

    const uploadStream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(new Error(`Cloudinary upload failed: ${error.message}`));
      resolve({
        url:      result.secure_url,
        publicId: result.public_id,
        width:    result.width,
        height:   result.height,
        format:   result.format,
        bytes:    result.bytes,
      });
    });

    uploadStream.end(fileBuffer);
  });
};

/**
 * Deletes an asset from Cloudinary by its public_id.
 * Used when removing vehicle images from a car record.
 *
 * @param {string} publicId - The Cloudinary public_id of the asset to remove.
 * @returns {Promise<void>}
 */
export const deleteFromCloudinary = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch (error) {
    // Non-fatal – log and continue (image may already be purged)
    console.error(`Cloudinary delete failed for publicId "${publicId}":`, error.message);
  }
};

export { cloudinary };
export default { configureCloudinary, uploadToCloudinary, deleteFromCloudinary };
