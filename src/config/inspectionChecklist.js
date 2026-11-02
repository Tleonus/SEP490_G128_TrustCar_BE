/**
 * @file inspectionChecklist.js
 * @description Central, versioned definition of the CPO inspection checklist:
 * the 5 criteria groups, their sub-items, the minor-defect types each group
 * accepts and the size limits applied to a checklist.
 *
 * Every inspection record stores the `checklistVersion` it was created with, so
 * a future change to this list never re-interprets records already filed.
 * To change the list, add a new version entry instead of editing an old one.
 */

export const CHECKLIST_VERSION = '1.0';

/** Positions of the 4 mandatory overview photos of the vehicle. */
export const OVERVIEW_POSITIONS = Object.freeze(['FRONT', 'REAR', 'LEFT', 'RIGHT']);

/** Result a staff member can record for one checklist item. */
export const ItemResult = Object.freeze({
  PASS:          'PASS',
  FAIL:          'FAIL',
  NOT_CHECKABLE: 'NOT_CHECKABLE',
});

/** Size limits for user-supplied checklist content. */
export const INSPECTION_LIMITS = Object.freeze({
  NOTE_MAX_LENGTH:          1000,
  VEHICLE_TEXT_MAX_LENGTH:  100,
  MIN_YEAR:                 1980,
  GROUP_PHOTOS_MAX:         10,
  ITEM_PHOTOS_MAX:          5,
  MINOR_DEFECTS_MAX:        20,
  MINOR_DEFECT_PHOTOS_MAX:  5,
});

const item = (key, label) => Object.freeze({ key, label });

const CHECKLISTS = Object.freeze({
  '1.0': Object.freeze([
    Object.freeze({
      key:         'G1_BODY_FRAME',
      label:       'Khung gầm, thân vỏ không đâm va',
      criteriaKey: 'noMajorAccident',
      requiresOdometerPhoto: false,
      items: Object.freeze([
        item('CHASSIS_RAILS', 'Dầm dọc, sắt xi trước/sau không biến dạng hay cắt hàn'),
        item('PILLARS', 'Trụ A/B/C không cắt hàn'),
        item('FLOOR_WHEEL_ARCHES', 'Sàn xe, hốc bánh không biến dạng'),
        item('PANEL_GAPS', 'Khe hở cửa, nắp capo, cốp đều'),
        item('NO_MAJOR_REPAINT', 'Không sơn lại diện rộng do va chạm'),
      ]),
      minorDefectTypes: Object.freeze([
        item('PAINT_SCRATCH_LIGHT', 'Xước sơn nhẹ'),
        item('DENT_MINOR', 'Móp nhẹ không nứt sơn'),
        item('TRIM_SCUFF', 'Trầy nhựa ốp/cản'),
        item('STONE_CHIP', 'Rỗ đá'),
      ]),
    }),
    Object.freeze({
      key:         'G2_FLOOD',
      label:       'Không ngập nước, thủy kích',
      criteriaKey: 'noWaterDamage',
      requiresOdometerPhoto: false,
      items: Object.freeze([
        item('CARPET_FLOOR', 'Sàn, thảm, nỉ không có bùn hay ẩm mốc'),
        item('SEAT_RAILS_BOLTS', 'Ray ghế, bulong chân ghế không gỉ'),
        item('SEATBELTS', 'Dây đai an toàn không vết bùn'),
        item('CONNECTORS_FUSEBOX', 'Giắc điện, hộp cầu chì không bị ôxy hóa'),
        item('CABIN_ODOR', 'Cabin không mùi ẩm mốc'),
      ]),
      minorDefectTypes: Object.freeze([]),
    }),
    Object.freeze({
      key:         'G3_ENGINE_GEARBOX',
      label:       'Động cơ, hộp số nguyên bản',
      criteriaKey: 'engineGearboxIntact',
      requiresOdometerPhoto: false,
      items: Object.freeze([
        item('ENGINE_START_NOISE', 'Nổ máy êm, không tiếng gõ lạ'),
        item('NO_LEAKS', 'Không rò dầu hay nước làm mát'),
        item('ENGINE_BOLTS_UNTOUCHED', 'Ốc nắp máy không có dấu tháo'),
        item('GEARBOX_SHIFTING', 'Hộp số chuyển số êm, không giật'),
        item('EXHAUST_SMOKE', 'Khói xả bình thường'),
      ]),
      minorDefectTypes: Object.freeze([
        item('ENGINE_BAY_TRIM_SCUFF', 'Trầy nhựa ốp khoang máy'),
        item('SURFACE_RUST_LIGHT', 'Gỉ bề mặt nhẹ'),
      ]),
    }),
    Object.freeze({
      key:         'G4_ODOMETER',
      label:       'ODO chuẩn, không tua',
      criteriaKey: 'verifiedOdo',
      requiresOdometerPhoto: true,
      items: Object.freeze([
        item('ODO_MATCHES_SERVICE_HISTORY', 'Số km khớp lịch sử bảo dưỡng'),
        item('WEAR_MATCHES_ODO', 'Độ mòn vô lăng, bàn đạp, ghế phù hợp số km'),
        item('CLUSTER_UNTAMPERED', 'Cụm đồng hồ không có dấu can thiệp'),
      ]),
      minorDefectTypes: Object.freeze([]),
    }),
    Object.freeze({
      key:         'G5_ELECTRICAL_SAFETY',
      label:       'Điện tử, an toàn hoạt động tốt',
      criteriaKey: 'electricalSystemPassed',
      requiresOdometerPhoto: false,
      items: Object.freeze([
        item('LIGHTS', 'Đèn chiếu sáng, xi nhan, đèn phanh'),
        item('DASHBOARD_WARNINGS', 'Không có đèn cảnh báo trên táp lô (kể cả túi khí)'),
        item('BRAKES_ABS', 'Phanh, ABS'),
        item('AIR_CONDITIONING', 'Điều hòa'),
        item('WINDOWS_LOCKS_MIRRORS', 'Kính điện, khóa cửa, gương'),
        item('INFOTAINMENT_CAMERA', 'Màn hình, âm thanh, camera'),
      ]),
      minorDefectTypes: Object.freeze([
        item('SCREEN_SCRATCH_LIGHT', 'Trầy màn hình nhẹ'),
        item('BUTTON_WEAR', 'Nút bấm mòn'),
      ]),
    }),
  ]),
});

/**
 * Returns the checklist groups for a version, or null when the version is unknown.
 * @param {string} [version=CHECKLIST_VERSION]
 * @returns {ReadonlyArray<object>|null}
 */
export const getChecklist = (version = CHECKLIST_VERSION) => CHECKLISTS[version] || null;

/**
 * Finds one group definition by key within a checklist version.
 * @param {string} groupKey
 * @param {string} [version=CHECKLIST_VERSION]
 * @returns {object|null}
 */
export const findGroup = (groupKey, version = CHECKLIST_VERSION) =>
  getChecklist(version)?.find((group) => group.key === groupKey) || null;

export default {
  CHECKLIST_VERSION,
  OVERVIEW_POSITIONS,
  ItemResult,
  INSPECTION_LIMITS,
  getChecklist,
  findGroup,
};
