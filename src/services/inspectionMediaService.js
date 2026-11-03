/**
 * @file inspectionMediaService.js
 * @description Evidence-photo handling for inspections. Photos are uploaded by
 * the client straight to Cloudinary with a short-lived signature issued here;
 * the backend then only accepts URLs that point into the project's own cloud
 * and the folder reserved for that inspection, so a public report can never
 * reference an arbitrary external image or another inspection's photos.
 */

import { v2 as cloudinary } from 'cloudinary';
import { AppError } from '../utils/apiResponse.js';

export const INSPECTION_FOLDER_ROOT = 'trustcar/inspections';
export const ALLOWED_IMAGE_FORMATS = Object.freeze(['jpg', 'png', 'webp']);

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Folder that a checklist inspection's evidence photos must live in. */
export const inspectionFolder = (inspectionId) => `${INSPECTION_FOLDER_ROOT}/${inspectionId}`;

/** Folder for evidence photos of a quick (5-boolean) inspection of one car. */
export const quickInspectionFolder = (carId) => `${INSPECTION_FOLDER_ROOT}/quick/${carId}`;

/**
 * Builds a signed direct-upload payload restricted to one folder.
 * Cloudinary rejects a signed upload whose timestamp is older than one hour.
 * The API secret is used to sign only and is never returned.
 *
 * @param {string} folder - inspectionFolder(...) or quickInspectionFolder(...)
 * @param {number} [nowMs=Date.now()]
 * @returns {{ cloudName: string, apiKey: string, timestamp: number, signature: string, folder: string, allowedFormats: string }}
 */
export const buildUploadSignature = (folder, nowMs = Date.now()) => {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new AppError('Image upload is not configured.', 503, 'UPLOAD_NOT_CONFIGURED');
  }

  const timestamp = Math.floor(nowMs / 1000);
  const allowedFormats = ALLOWED_IMAGE_FORMATS.join(',');
  const signature = cloudinary.utils.api_sign_request(
    { timestamp, folder, allowed_formats: allowedFormats },
    CLOUDINARY_API_SECRET,
  );

  return { cloudName: CLOUDINARY_CLOUD_NAME, apiKey: CLOUDINARY_API_KEY, timestamp, signature, folder, allowedFormats };
};

/**
 * True only for the exact `secure_url` shape Cloudinary returns for an upload
 * into `folder`: https://res.cloudinary.com/<cloud>/image/upload/[v<digits>/]<folder>/<file>.
 * Transformation segments (e.g. l_fetch, l_text overlays), nested or other
 * folders are rejected, so stored evidence always shows the original upload.
 *
 * @param {string} url
 * @param {string} folder
 * @returns {boolean}
 */
export const isImageInFolder = (url, folder) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName || !folder || typeof url !== 'string' || url.includes('..')) return false;

  const pattern = `^https://res\\.cloudinary\\.com/${escapeRegExp(cloudName)}/image/upload/`
    + `(?:v\\d+/)?${escapeRegExp(folder)}/[^/?#\\s]+$`;
  return new RegExp(pattern).test(url);
};

/** True when the URL is an original upload inside the given checklist inspection's folder. */
export const isInspectionImageUrl = (url, inspectionId) =>
  Boolean(inspectionId) && isImageInFolder(url, inspectionFolder(inspectionId));

/**
 * True for an original upload anywhere in the project's Cloudinary cloud, as
 * shown on public pages: https://res.cloudinary.com/<cloud>/image/upload/[v<digits>/]<folders>/<file>.
 * Folder names may only contain letters, digits and '-', so transformation
 * segments (which always contain '_', ',' or ':') can never pass; files from
 * another cloud or any other host are rejected as well.
 *
 * @param {string} url
 * @returns {boolean}
 */
export const isPublicImageUrl = (url) => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName || typeof url !== 'string' || url.includes('..')) return false;

  const pattern = `^https://res\\.cloudinary\\.com/${escapeRegExp(cloudName)}/image/upload/`
    + '(?:v\\d+/)?(?:[A-Za-z0-9-]+/)*[^/?#\\s,:]+$';
  return new RegExp(pattern).test(url);
};

export default {
  buildUploadSignature,
  isPublicImageUrl,
  isImageInFolder,
  isInspectionImageUrl,
  inspectionFolder,
  quickInspectionFolder,
};
