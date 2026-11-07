/**
 * @file wishlistService.js
 * @description Business logic for Saved Cars Wishlist & Price Drop Alerts.
 *
 * Supports two complementary UX modes:
 * 1. Guest Mode (unauthenticated):
 *    - Clicking "Save" on the frontend persists only in browser `localStorage`
 *      and triggers a Signup Prompt Popup.
 *    - `previewGuestWishlist` lets guests view live public vehicle cards for
 *      their `localStorage` IDs with zero database writes.
 * 2. Authenticated Customer Mode (`CUSTOMER` role with complete profile):
 *    - `syncGuestWishlist` migrates `localStorage` vehicle IDs into MongoDB
 *      immediately after signup/login and instructs the client to clear `localStorage`.
 *    - Full CRUD on saved vehicles, server-side `priceAtSave` snapshot, per-car
 *      `priceAlertEnabled` toggle, in-app Price Drop Alerts, and automated
 *      branded email alerts whenever an AVAILABLE car's price drops.
 */

import ActivityLog from '../models/ActivityLog.js';
import { sendMail } from '../config/mailer.js';
import { emailButton, frontendUrl } from '../utils/emailLayout.js';
import { AppError, parsePagination, buildPaginationMeta } from '../utils/apiResponse.js';
import { logger } from '../utils/logger.js';
import {
  CarStatus,
  ActivityEventType,
  PAGINATION,
} from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import * as wishlistRepo from '../repositories/wishlistRepository.js';

export const MAX_WISHLIST_ITEMS = 100;

export const GUEST_SIGNUP_PROMPT = Object.freeze({
  required: true,
  code: 'SIGNUP_FOR_PERSISTENCE_AND_ALERTS',
  title: 'Đăng nhập để lưu xe & nhận thông báo giảm giá',
  message:
    'Danh sách xe yêu thích hiện chỉ lưu tạm trên trình duyệt này. Đăng ký hoặc đăng nhập tài khoản để đồng bộ trên mọi thiết bị và nhận cảnh báo ngay khi xe giảm giá!',
});

// ════════════════════════════════════════════════════════════════════════════
// HELPERS & STRICT ALLOW-LIST DTO MAPPERS
// ════════════════════════════════════════════════════════════════════════════

const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));

const formatVnd = (amount) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(Number(amount) || 0));

const computeDropPercentage = (basePrice, currentPrice) => {
  if (!basePrice || basePrice <= 0 || currentPrice >= basePrice) return 0;
  return Number((((basePrice - currentPrice) / basePrice) * 100).toFixed(2));
};

const pickPrimaryImageUrl = (images) => {
  const list = Array.isArray(images) ? images : [];
  const primary = list.find((item) => item?.isPrimary) ?? list[0];
  return primary?.url ?? null;
};

const isCarPubliclyAvailable = (car) =>
  Boolean(car && car.isActive === true && car.status === CarStatus.AVAILABLE);

/**
 * Maps a Car document to a customer-safe wishlist vehicle card DTO.
 * Enforces an explicit field allow-list so internal fields (`vin`, `licensePlate`,
 * `floorPrice`, `priceHistory`, `internalNotes`, `images.publicId`, `status`,
 * `isActive`, `createdBy`, etc.) never leak to clients.
 *
 * @param {object} car
 * @returns {object}
 */
export const toWishlistCarDto = (car) => {
  const dto = { _id: String(car._id) };
  wishlistRepo.WISHLIST_CAR_BASIC_FIELDS.forEach((field) => {
    dto[field] = car[field] ?? null;
  });
  dto.primaryImageUrl = pickPrimaryImageUrl(car.images);
  dto.isAvailable = isCarPubliclyAvailable(car);
  return dto;
};

/**
 * Maps a PriceDropAlert subdocument to its public DTO.
 *
 * @param {object} alert
 * @returns {object}
 */
export const toPriceAlertDto = (alert) => ({
  _id: String(alert._id),
  oldPrice: alert.oldPrice,
  newPrice: alert.newPrice,
  dropAmount: alert.dropAmount,
  dropPercentage: computeDropPercentage(alert.oldPrice, alert.newPrice),
  notifiedAt: alert.notifiedAt,
  emailSent: Boolean(alert.emailSent),
  isRead: Boolean(alert.isRead),
});

/**
 * Maps a SavedCar record + its associated Car document into a wishlist item DTO.
 *
 * @param {object} saved - Lean SavedCar document.
 * @param {object|null} car - Lean Car document (or null if missing).
 * @returns {object}
 */
export const toWishlistItemDto = (saved, car) => {
  const available = isCarPubliclyAvailable(car);
  const currentPrice = car ? car.price : null;
  const priceDropped = Boolean(available && typeof currentPrice === 'number' && currentPrice < saved.priceAtSave);
  const dropAmount = priceDropped ? saved.priceAtSave - currentPrice : 0;
  const dropPercentage = priceDropped ? computeDropPercentage(saved.priceAtSave, currentPrice) : 0;

  const alerts = Array.isArray(saved.priceAlerts) ? saved.priceAlerts : [];
  const unreadAlertsCount = alerts.reduce((acc, item) => acc + (item.isRead ? 0 : 1), 0);
  const latestRawAlert = alerts.length > 0 ? alerts[alerts.length - 1] : null;

  return {
    _id: String(saved._id),
    carId: String(saved.car),
    savedAt: saved.createdAt,
    priceAtSave: saved.priceAtSave,
    currentPrice,
    isAvailable: available,
    priceDropped,
    dropAmount,
    dropPercentage,
    priceAlertEnabled: Boolean(saved.priceAlertEnabled),
    unreadAlertsCount,
    lastAlert: latestRawAlert ? toPriceAlertDto(latestRawAlert) : null,
    car: car ? toWishlistCarDto(car) : null,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// GUEST LOCALSTORAGE PREVIEW (READ-ONLY, NO AUTH)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns live public vehicle cards for IDs stored in a guest's browser
 * `localStorage`, plus a Signup Prompt descriptor reminding the UI that
 * persistence and Price Drop Alerts require logging in.
 *
 * Read-only: writes nothing to the database and creates no audit logs.
 *
 * @param {string[]} ids - Deduplicated, validated 24-hex ObjectId strings (0–50 items).
 * @returns {Promise<object>}
 */
export const previewGuestWishlist = async (ids = []) => {
  if (!ids.length) {
    return {
      guestMode: true,
      storageStrategy: 'LOCAL_STORAGE',
      signupPrompt: GUEST_SIGNUP_PROMPT,
      cars: [],
      unavailableIds: [],
    };
  }

  const docs = await wishlistRepo.findAvailableCarsByIds(ids);
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));

  const cars = [];
  const unavailableIds = [];

  ids.forEach((id) => {
    const doc = byId.get(id);
    if (doc) cars.push(toWishlistCarDto(doc));
    else unavailableIds.push(id);
  });

  return {
    guestMode: true,
    storageStrategy: 'LOCAL_STORAGE',
    signupPrompt: GUEST_SIGNUP_PROMPT,
    cars,
    unavailableIds,
  };
};

// ════════════════════════════════════════════════════════════════════════════
// AUTHENTICATED CUSTOMER WISHLIST OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns a lightweight summary of saved car IDs and unread alert count for
 * navbar badges and catalog heart icons.
 *
 * @param {string} userId
 * @returns {Promise<{ carIds: string[], totalSaved: number, unreadAlertsCount: number }>}
 */
export const getSavedCarIds = async (userId) => {
  const savedList = await wishlistRepo.findAllSavedByUser(userId);
  const carIds = savedList.map((item) => String(item.car));
  const unreadAlertsCount = savedList.reduce((sum, item) => {
    const alerts = Array.isArray(item.priceAlerts) ? item.priceAlerts : [];
    return sum + alerts.filter((a) => !a.isRead).length;
  }, 0);

  return {
    carIds,
    totalSaved: carIds.length,
    unreadAlertsCount,
  };
};

/**
 * Returns the authenticated customer's paginated Saved Cars Wishlist.
 *
 * @param {string} userId
 * @param {object} query - { page, limit }
 * @returns {Promise<{ items: object[], pagination: object }>}
 */
export const getWishlist = async (userId, query = {}) => {
  const { page, limit, skip } = parsePagination(query, PAGINATION.MAX_LIMIT);
  const { items: savedDocs, total } = await wishlistRepo.findPaginatedSavedByUser(userId, { skip, limit });

  const carIds = savedDocs.map((doc) => doc.car);
  const cars = await wishlistRepo.findCarsByIdsForWishlist(carIds);
  const carById = new Map(cars.map((c) => [String(c._id), c]));

  const items = savedDocs.map((saved) =>
    toWishlistItemDto(saved, carById.get(String(saved.car)) ?? null)
  );

  return {
    items,
    pagination: buildPaginationMeta(total, page, limit),
  };
};

/**
 * Saves an AVAILABLE vehicle to the authenticated customer's wishlist.
 * Idempotent: if the vehicle is already saved, returns `created: false`
 * without overwriting `priceAtSave`.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.carId
 * @param {boolean} [params.priceAlertEnabled]
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<{ created: boolean, alreadySaved: boolean, item: object }>}
 */
export const saveCarToWishlist = async ({
  userId,
  carId,
  priceAlertEnabled,
  ipAddress,
  userAgent,
}) => {
  const existing = await wishlistRepo.findSavedByUserAndCar(userId, carId);
  if (existing) {
    let latestSaved = existing;
    if (typeof priceAlertEnabled === 'boolean' && existing.priceAlertEnabled !== priceAlertEnabled) {
      latestSaved = await wishlistRepo.updateAlertPreference(userId, carId, priceAlertEnabled);
    }
    const [car] = await wishlistRepo.findCarsByIdsForWishlist([carId]);
    return {
      created: false,
      alreadySaved: true,
      item: toWishlistItemDto(latestSaved, car ?? null),
    };
  }

  const car = await wishlistRepo.findAvailableCarById(carId);
  if (!car) {
    throw new AppError(
      'Vehicle not found or is not currently available.',
      404,
      MSG.MSG61.code
    );
  }

  const currentCount = await wishlistRepo.countSavedByUser(userId);
  if (currentCount >= MAX_WISHLIST_ITEMS) {
    throw new AppError(MSG.MSG78.message, MSG.MSG78.httpStatus, MSG.MSG78.code);
  }

  const alertFlag = typeof priceAlertEnabled === 'boolean' ? priceAlertEnabled : true;

  let saved;
  try {
    saved = await wishlistRepo.createSavedCar({
      userId,
      carId: car._id,
      priceAtSave: car.price, // Always snapshot server-side price
      priceAlertEnabled: alertFlag,
    });
  } catch (err) {
    // Handle concurrent save race condition gracefully
    if (err?.code === 11000) {
      const concurrent = await wishlistRepo.findSavedByUserAndCar(userId, carId);
      if (concurrent) {
        return {
          created: false,
          alreadySaved: true,
          item: toWishlistItemDto(concurrent, car),
        };
      }
    }
    throw err;
  }

  await ActivityLog.log({
    eventType: ActivityEventType.CAR_SAVED_WISHLIST,
    performedBy: userId,
    targetModel: 'Car',
    targetId: car._id,
    targetCode: car.vehicleCode,
    summary: `Customer saved vehicle ${car.vehicleCode} to wishlist`,
    ipAddress,
    userAgent,
  });

  return {
    created: true,
    alreadySaved: false,
    item: toWishlistItemDto(saved, car),
  };
};

/**
 * Syncs vehicle IDs stored in browser `localStorage` into the authenticated
 * customer's persistent database wishlist right after login or registration.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string[]} params.carIds - Validated 24-hex ObjectId strings (0–50 items).
 * @param {boolean} [params.priceAlertEnabled=true]
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<object>}
 */
export const syncGuestWishlist = async ({
  userId,
  carIds = [],
  priceAlertEnabled = true,
  ipAddress,
  userAgent,
}) => {
  const uniqueIds = [...new Set(carIds.map((id) => id.trim().toLowerCase()))];

  if (!uniqueIds.length) {
    return {
      syncedCount: 0,
      alreadySavedCount: 0,
      unavailableIds: [],
      clearLocalStorage: true,
      items: [],
    };
  }

  const [availableCars, existingSaved] = await Promise.all([
    wishlistRepo.findAvailableCarsByIds(uniqueIds),
    wishlistRepo.findSavedByUserAndCars(userId, uniqueIds),
  ]);

  const availableById = new Map(availableCars.map((c) => [String(c._id), c]));
  const existingByCarId = new Map(existingSaved.map((s) => [String(s.car), s]));

  const toInsertCars = [];
  const unavailableIds = [];
  let alreadySavedCount = 0;

  uniqueIds.forEach((id) => {
    if (existingByCarId.has(id)) {
      alreadySavedCount += 1;
    } else if (availableById.has(id)) {
      toInsertCars.push(availableById.get(id));
    } else {
      unavailableIds.push(id);
    }
  });

  if (toInsertCars.length > 0) {
    const currentCount = await wishlistRepo.countSavedByUser(userId);
    if (currentCount + toInsertCars.length > MAX_WISHLIST_ITEMS) {
      throw new AppError(MSG.MSG78.message, MSG.MSG78.httpStatus, MSG.MSG78.code);
    }
  }

  let syncedCount = 0;
  for (const car of toInsertCars) {
    try {
      const created = await wishlistRepo.createSavedCar({
        userId,
        carId: car._id,
        priceAtSave: car.price,
        priceAlertEnabled,
      });
      existingByCarId.set(String(car._id), created);
      syncedCount += 1;
    } catch (err) {
      if (err?.code === 11000) {
        alreadySavedCount += 1;
        const concurrent = await wishlistRepo.findSavedByUserAndCar(userId, car._id);
        if (concurrent) existingByCarId.set(String(car._id), concurrent);
      } else {
        throw err;
      }
    }
  }

  if (syncedCount > 0) {
    await ActivityLog.log({
      eventType: ActivityEventType.WISHLIST_SYNCED,
      performedBy: userId,
      targetModel: 'User',
      targetId: userId,
      summary: `Synced ${syncedCount} guest localStorage vehicle(s) to customer wishlist`,
      ipAddress,
      userAgent,
    });
  }

  const allReferencedCarIds = [...existingByCarId.keys()];
  const allCars = await wishlistRepo.findCarsByIdsForWishlist(allReferencedCarIds);
  const allCarsById = new Map(allCars.map((c) => [String(c._id), c]));

  const items = uniqueIds
    .filter((id) => existingByCarId.has(id))
    .map((id) => toWishlistItemDto(existingByCarId.get(id), allCarsById.get(id) ?? null));

  return {
    syncedCount,
    alreadySavedCount,
    unavailableIds,
    clearLocalStorage: true,
    items,
  };
};

/**
 * Enables or disables Price Drop Alerts for a specific saved vehicle.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.carId
 * @param {boolean} params.priceAlertEnabled
 * @returns {Promise<object>} Updated wishlist item DTO.
 */
export const togglePriceAlert = async ({ userId, carId, priceAlertEnabled }) => {
  const updated = await wishlistRepo.updateAlertPreference(userId, carId, priceAlertEnabled);
  if (!updated) {
    throw new AppError(MSG.MSG76.message, MSG.MSG76.httpStatus, MSG.MSG76.code);
  }

  const [car] = await wishlistRepo.findCarsByIdsForWishlist([carId]);
  return toWishlistItemDto(updated, car ?? null);
};

/**
 * Removes a vehicle from the authenticated customer's wishlist.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.carId
 * @param {string} [params.ipAddress]
 * @param {string} [params.userAgent]
 * @returns {Promise<{ carId: string, removed: boolean }>}
 */
export const removeCarFromWishlist = async ({ userId, carId, ipAddress, userAgent }) => {
  const deleted = await wishlistRepo.deleteSavedCar(userId, carId);
  if (!deleted) {
    throw new AppError(MSG.MSG76.message, MSG.MSG76.httpStatus, MSG.MSG76.code);
  }

  await ActivityLog.log({
    eventType: ActivityEventType.CAR_REMOVED_WISHLIST,
    performedBy: userId,
    targetModel: 'Car',
    targetId: deleted.car,
    summary: `Customer removed vehicle ${carId} from wishlist`,
    ipAddress,
    userAgent,
  });

  return { carId: String(carId), removed: true };
};

// ════════════════════════════════════════════════════════════════════════════
// PRICE DROP ALERTS – IN-APP FEED & EMAIL DISPATCHER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns paginated Price Drop Alerts across the customer's saved vehicles,
 * sorted newest first.
 *
 * @param {string} userId
 * @param {object} query - { unreadOnly, page, limit }
 * @returns {Promise<{ items: object[], pagination: object, unreadAlertsCount: number }>}
 */
export const getPriceDropAlerts = async (userId, query = {}) => {
  const { page, limit, skip } = parsePagination(query, PAGINATION.MAX_LIMIT);
  const unreadOnly = query.unreadOnly === true || query.unreadOnly === 'true';

  const savedDocs = await wishlistRepo.findAllSavedByUser(userId);

  let unreadAlertsCount = 0;
  const flatAlerts = [];

  savedDocs.forEach((saved) => {
    const alerts = Array.isArray(saved.priceAlerts) ? saved.priceAlerts : [];
    alerts.forEach((alert) => {
      if (!alert.isRead) unreadAlertsCount += 1;
      if (unreadOnly && alert.isRead) return;
      flatAlerts.push({
        savedId: String(saved._id),
        carId: String(saved.car),
        priceAtSave: saved.priceAtSave,
        alert,
      });
    });
  });

  flatAlerts.sort((a, b) => {
    const diff = new Date(b.alert.notifiedAt).getTime() - new Date(a.alert.notifiedAt).getTime();
    if (diff !== 0) return diff;
    return String(b.alert._id).localeCompare(String(a.alert._id));
  });

  const total = flatAlerts.length;
  const pageSlice = flatAlerts.slice(skip, skip + limit);

  const pageCarIds = [...new Set(pageSlice.map((entry) => entry.carId))];
  const cars = await wishlistRepo.findCarsByIdsForWishlist(pageCarIds);
  const carById = new Map(cars.map((c) => [String(c._id), c]));

  const items = pageSlice.map(({ savedId, carId, priceAtSave, alert }) => {
    const car = carById.get(carId) ?? null;
    return {
      ...toPriceAlertDto(alert),
      savedId,
      carId,
      priceAtSave,
      car: car ? toWishlistCarDto(car) : null,
    };
  });

  return {
    items,
    pagination: buildPaginationMeta(total, page, limit),
    unreadAlertsCount,
  };
};

/**
 * Marks a single Price Drop Alert belonging to the authenticated customer as read.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.alertId
 * @returns {Promise<object>} Updated alert DTO.
 */
export const markPriceAlertRead = async ({ userId, alertId }) => {
  const updatedSaved = await wishlistRepo.markAlertAsRead(userId, alertId);
  if (!updatedSaved) {
    throw new AppError(MSG.MSG77.message, MSG.MSG77.httpStatus, MSG.MSG77.code);
  }

  const alert = updatedSaved.priceAlerts.find((entry) => String(entry._id) === String(alertId));
  return toPriceAlertDto(alert);
};

/**
 * Marks all unread Price Drop Alerts of the authenticated customer as read.
 *
 * @param {string} userId
 * @returns {Promise<{ markedCount: number }>}
 */
export const markAllPriceAlertsRead = async (userId) => {
  const markedCount = await wishlistRepo.markAllAlertsAsRead(userId);
  return { markedCount };
};

/**
 * Builds the HTML email content for a Price Drop Alert.
 */
const buildPriceDropEmailHtml = ({ fullName, carTitle, vehicleCode, oldPrice, newPrice, dropAmount, dropPct, carUrl }) => `
  <h2 style="margin:0 0 16px;font-size:22px;color:#ffffff;">Xe bạn yêu thích vừa giảm giá!</h2>
  <p style="margin:0 0 12px;">Xin chào ${escapeHtml(fullName || 'Quý khách')},</p>
  <p style="margin:0 0 16px;">Mẫu xe <strong>${escapeHtml(carTitle)}</strong> (${escapeHtml(vehicleCode)}) trong danh sách yêu thích của bạn tại TrustCar vừa được điều chỉnh giá ưu đãi hơn:</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin:0 0 20px;background:#0a1428;border:1px solid #1f2a44;border-radius:10px;padding:16px;">
    <tr>
      <td style="padding:6px 12px;color:#94a3b8;font-size:14px;">Giá trước đây:</td>
      <td style="padding:6px 12px;color:#94a3b8;font-size:14px;text-decoration:line-through;text-align:right;">${formatVnd(oldPrice)} VNĐ</td>
    </tr>
    <tr>
      <td style="padding:6px 12px;color:#e2e8f0;font-size:15px;font-weight:600;">Giá mới hiện tại:</td>
      <td style="padding:6px 12px;color:#38bdf8;font-size:18px;font-weight:700;text-align:right;">${formatVnd(newPrice)} VNĐ</td>
    </tr>
    <tr>
      <td style="padding:6px 12px;color:#4ade80;font-size:14px;">Mức giảm:</td>
      <td style="padding:6px 12px;color:#4ade80;font-size:14px;font-weight:600;text-align:right;">-${formatVnd(dropAmount)} VNĐ (${dropPct}%)</td>
    </tr>
  </table>
  ${emailButton('Xem chi tiết xe ngay', carUrl)}
  <p style="margin:0;font-size:13px;color:#94a3b8;">Bạn nhận được email này vì đã bật thông báo giảm giá cho xe trong danh sách Yêu thích trên TrustCar. Bạn có thể tắt thông báo bất kỳ lúc nào trong mục Xe đã lưu.</p>
`;

/**
 * Triggers in-app Price Drop Alerts and sends branded emails to all active
 * customers who saved `carId` with `priceAlertEnabled = true`.
 *
 * Only runs when `newPrice < oldPrice` and the car is currently `AVAILABLE`
 * and `isActive = true`.
 *
 * @param {object} params
 * @param {string|object} params.carId
 * @param {number} params.oldPrice
 * @param {number} params.newPrice
 * @param {string|object|null} [params.priceHistoryId=null]
 * @param {string|object|null} [params.performedBy=null]
 * @returns {Promise<{ notifiedCount: number, emailedCount: number }>}
 */
export const notifyPriceDropForCar = async ({
  carId,
  oldPrice,
  newPrice,
  priceHistoryId = null,
  performedBy = null,
}) => {
  if (
    typeof oldPrice !== 'number' ||
    typeof newPrice !== 'number' ||
    newPrice <= 0 ||
    newPrice >= oldPrice
  ) {
    return { notifiedCount: 0, emailedCount: 0 };
  }

  const car = await wishlistRepo.findCarForAlertNotification(carId);
  if (!car || car.isActive === false || String(car.status).toUpperCase() !== CarStatus.AVAILABLE) {
    return { notifiedCount: 0, emailedCount: 0 };
  }

  const subscribers = await wishlistRepo.findAlertSubscribersByCar(car._id);
  if (!subscribers.length) {
    return { notifiedCount: 0, emailedCount: 0 };
  }

  const subscriberUserIds = subscribers.map((sub) => sub.user);
  const activeUsers = await wishlistRepo.findActiveCustomersByIds(subscriberUserIds);
  if (!activeUsers.length) {
    return { notifiedCount: 0, emailedCount: 0 };
  }

  const userById = new Map(activeUsers.map((u) => [String(u._id), u]));
  const dropAmount = oldPrice - newPrice;
  const dropPct = computeDropPercentage(oldPrice, newPrice);
  const carTitle = [car.year, car.make, car.model, car.variant].filter(Boolean).join(' ');
  const vehicleCode = car.vehicleCode || String(car._id);
  const carUrl = `${frontendUrl()}/cars/${encodeURIComponent(car.vehicleCode || String(car._id))}`;
  const notifiedAt = new Date();

  let notifiedCount = 0;
  let emailedCount = 0;

  for (const sub of subscribers) {
    const user = userById.get(String(sub.user));
    if (!user) continue;

    let emailSent = false;
    if (user.email) {
      try {
        await sendMail({
          to: user.email,
          toName: user.fullName || '',
          subject: `TrustCar – ${carTitle} vừa giảm ${formatVnd(dropAmount)} VNĐ!`,
          preheader: `Giá mới chỉ ${formatVnd(newPrice)} VNĐ (giảm ${formatVnd(dropAmount)} VNĐ).`,
          html: buildPriceDropEmailHtml({
            fullName: user.fullName,
            carTitle,
            vehicleCode,
            oldPrice,
            newPrice,
            dropAmount,
            dropPct,
            carUrl,
          }),
        });
        emailSent = true;
        emailedCount += 1;
      } catch (mailErr) {
        logger.error(`Price drop alert email failed for user ${user._id} on car ${car._id}: ${mailErr.message}`);
      }
    }

    await wishlistRepo.appendPriceAlert(sub._id, {
      oldPrice,
      newPrice,
      dropAmount,
      notifiedAt,
      emailSent,
      isRead: false,
    });
    notifiedCount += 1;
  }

  if (priceHistoryId && notifiedCount > 0) {
    await wishlistRepo.updatePriceHistoryNotifiedCount(priceHistoryId, notifiedCount);
  }

  if (notifiedCount > 0 && performedBy) {
    await ActivityLog.log({
      eventType: ActivityEventType.PRICE_ALERT_SENT,
      performedBy,
      targetModel: 'Car',
      targetId: car._id,
      targetCode: car.vehicleCode,
      summary: `Sent ${notifiedCount} price drop alert(s) for ${vehicleCode} (${oldPrice} → ${newPrice} VND)`,
    });
  }

  return { notifiedCount, emailedCount };
};

/**
 * Non-throwing wrapper around `notifyPriceDropForCar` so staff/admin price
 * updates and markdown jobs never fail if alert delivery encounters an error.
 */
export const dispatchPriceDropAlertsSafely = async (params) => {
  try {
    return await notifyPriceDropForCar(params);
  } catch (err) {
    logger.error(`Failed to dispatch price drop alerts for car ${params?.carId}: ${err.message}`);
    return { notifiedCount: 0, emailedCount: 0 };
  }
};

export default {
  MAX_WISHLIST_ITEMS,
  GUEST_SIGNUP_PROMPT,
  toWishlistCarDto,
  toPriceAlertDto,
  toWishlistItemDto,
  previewGuestWishlist,
  getSavedCarIds,
  getWishlist,
  saveCarToWishlist,
  syncGuestWishlist,
  togglePriceAlert,
  removeCarFromWishlist,
  getPriceDropAlerts,
  markPriceAlertRead,
  markAllPriceAlertsRead,
  notifyPriceDropForCar,
  dispatchPriceDropAlertsSafely,
};

