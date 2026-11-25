import {
  buildUploadSignature, inspectionFolder, isImageInFolder, quickInspectionFolder,
} from '../../services/inspectionMediaService.js';

const OBJECT_ID = /^[a-f0-9]{24}$/i;

function normalizedId(id) {
  return typeof id === 'string' && OBJECT_ID.test(id) ? id.toLowerCase() : null;
}

function signPhoto(id, folderFor, nowMs) {
  const canonicalId = normalizedId(id);
  if (!canonicalId) throw new TypeError('Expected a valid inspection resource ID.');
  return buildUploadSignature(folderFor(canonicalId), nowMs);
}

/**
 * Verify the original upload URL and check its decoded filename.
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-013
 * @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-021
 */
function isOriginalUpload(url, folderFor, id) {
  const canonicalId = normalizedId(id);
  if (!canonicalId || !isImageInFolder(url, folderFor(canonicalId))) return false;
  try {
    const file = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    return !file.includes('..') && !/[\\/?#\s\u0000-\u001f\u007f]|%[a-f0-9]{2}/i.test(file);
  } catch {
    return false;
  }
}

/** Bind uploads to either the draft or a quick inspection for a specific car. */
export function createInspectionMediaAdapter({ now = Date.now } = {}) {
  return {
    /** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-010 */
    signInspectionPhoto: (id) => signPhoto(id, inspectionFolder, now()),
    /** @ears .sdd/features/kan-6-cpo-inspection-checklist/SPEC.md#REQ-031 */
    signQuickInspectionPhoto: (id) => signPhoto(id, quickInspectionFolder, now()),
    isInspectionImageUrl: (url, id) => isOriginalUpload(url, inspectionFolder, id),
    isQuickInspectionImageUrl: (url, id) => isOriginalUpload(url, quickInspectionFolder, id),
  };
}
