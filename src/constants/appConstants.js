/**
 * @file appConstants.js
 * @description Core application enumerations, state machines, and lookup tables
 * for the TrustCar platform. All "magic strings" must be imported from here –
 * no inline string literals for domain values anywhere in the codebase.
 *
 * Ref: FE-09, FE-12, FE-13, GBR-04 through GBR-11, GBR-12, GBR-17
 */

// ── Vehicle Lifecycle States ──────────────────────────────────────────────────
// Ref: GBR-05 (state machine), GBR-06 (sold lock), FE-09
export const CarStatus = Object.freeze({
  INCOMING:    'INCOMING',    // Intake initiated; not yet certified or publicly listed
  MAINTENANCE: 'MAINTENANCE', // Undergoing pre-sale conditioning (scheduling ONLY – LI-05)
  AVAILABLE:   'AVAILABLE',   // Passed inspection; listed on public catalog
  RESERVED:    'RESERVED',    // Hold placed by a customer; blocks new viewings
  SOLD:        'SOLD',        // Transaction completed; record becomes read-only (GBR-06)
  DELISTED:    'DELISTED',    // Manually removed; not sold (terminal state)
});

/**
 * Valid status transitions (State Machine).
 * Key = current status; Value = array of allowed next statuses.
 * Ref: GBR-05
 */
export const CAR_STATUS_TRANSITIONS = Object.freeze({
  [CarStatus.INCOMING]:    [CarStatus.AVAILABLE, CarStatus.MAINTENANCE, CarStatus.DELISTED],
  [CarStatus.MAINTENANCE]: [CarStatus.AVAILABLE, CarStatus.DELISTED],
  [CarStatus.AVAILABLE]:   [CarStatus.RESERVED, CarStatus.DELISTED],
  [CarStatus.RESERVED]:    [CarStatus.AVAILABLE, CarStatus.SOLD],
  [CarStatus.SOLD]:        [], // Terminal – GBR-06
  [CarStatus.DELISTED]:    [], // Terminal – GBR-25
});

// ── CRM Lead / Sales Pipeline Stages ─────────────────────────────────────────
// Ref: GBR-17, GBR-18, FE-10
export const LeadStage = Object.freeze({
  NEW:         'NEW',
  CONTACTED:   'CONTACTED',
  QUALIFIED:   'QUALIFIED',
  NEGOTIATING: 'NEGOTIATING',
  WON:         'WON',
  LOST:        'LOST',
});

/** Forward-only allowed transitions for Lead stages. Ref: GBR-17 */
export const LEAD_STAGE_TRANSITIONS = Object.freeze({
  [LeadStage.NEW]:         [LeadStage.CONTACTED, LeadStage.LOST],
  [LeadStage.CONTACTED]:   [LeadStage.QUALIFIED, LeadStage.LOST],
  [LeadStage.QUALIFIED]:   [LeadStage.NEGOTIATING, LeadStage.LOST],
  [LeadStage.NEGOTIATING]: [LeadStage.WON, LeadStage.LOST],
  [LeadStage.WON]:         [], // Terminal
  [LeadStage.LOST]:        [], // Terminal
});

// ── Appointment Types & Statuses ──────────────────────────────────────────────
// Ref: FE-05, FE-06, FE-07, LI-05 (maintenance scheduling ONLY)
export const AppointmentType = Object.freeze({
  TEST_DRIVE:  'TEST_DRIVE',
  VIEWING:     'VIEWING',
  MAINTENANCE: 'MAINTENANCE', // Intake scheduling ONLY – NO garage execution (LI-05)
});

export const AppointmentStatus = Object.freeze({
  PENDING:   'PENDING',
  CONFIRMED: 'CONFIRMED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW:   'NO_SHOW',
});

// ── User Roles ────────────────────────────────────────────────────────────────
// Ref: FE-12, FE-13, GBR-02, GBR-03
export const Roles = Object.freeze({
  ADMIN:       'ADMIN',
  SALES_STAFF: 'SALES_STAFF',
  CUSTOMER:    'CUSTOMER', // self-registered website customer – no internal permissions
});

// Internal (staff) roles – the only roles Admin can assign via user management.
export const StaffRoles = Object.freeze([Roles.ADMIN, Roles.SALES_STAFF]);

// ── Granular Permissions ───────────────────────────────────────────────────────
// Ref: FE-13
export const Permissions = Object.freeze({
  // ── User / Account Management ──
  USER_CREATE:       'user:create',
  USER_READ:         'user:read',
  USER_UPDATE:       'user:update',
  USER_DEACTIVATE:   'user:deactivate',

  // ── Vehicle Inventory (Staff + Admin) ──
  CAR_CREATE:        'car:create',
  CAR_READ:          'car:read',
  CAR_UPDATE:        'car:update',
  CAR_STATUS_CHANGE: 'car:status_change',
  CAR_IMAGE_MANAGE:  'car:image_manage',

  // ── Customer & Lead (CRM) ──
  CUSTOMER_READ:     'customer:read',
  CUSTOMER_CREATE:   'customer:create',
  CUSTOMER_UPDATE:   'customer:update',
  LEAD_READ:         'lead:read',
  LEAD_CREATE:       'lead:create',
  LEAD_UPDATE:       'lead:update',

  // ── Appointments ──
  APPOINTMENT_READ:   'appointment:read',
  APPOINTMENT_CREATE: 'appointment:create',
  APPOINTMENT_UPDATE: 'appointment:update',

  // ── Reporting / Analytics ──
  REPORT_VIEW:       'report:view',
  REPORT_EXPORT:     'report:export',
});

// ── Role → Permission Matrix ───────────────────────────────────────────────────
export const ROLE_PERMISSIONS = Object.freeze({
  [Roles.ADMIN]: Object.values(Permissions),

  [Roles.SALES_STAFF]: [
    Permissions.CAR_READ,
    Permissions.CAR_CREATE,
    Permissions.CAR_UPDATE,
    Permissions.CAR_STATUS_CHANGE,
    Permissions.CAR_IMAGE_MANAGE,
    Permissions.CUSTOMER_READ,
    Permissions.CUSTOMER_CREATE,
    Permissions.CUSTOMER_UPDATE,
    Permissions.LEAD_READ,
    Permissions.LEAD_CREATE,
    Permissions.LEAD_UPDATE,
    Permissions.APPOINTMENT_READ,
    Permissions.APPOINTMENT_CREATE,
    Permissions.APPOINTMENT_UPDATE,
    Permissions.REPORT_VIEW,
  ],

  [Roles.CUSTOMER]: [],
});

// ── Vehicle Specification Enums ───────────────────────────────────────────────
export const FuelType = Object.freeze({
  GASOLINE:  'GASOLINE',
  DIESEL:    'DIESEL',
  HYBRID:    'HYBRID',
  ELECTRIC:  'ELECTRIC',
  LPG:       'LPG',
});

export const Transmission = Object.freeze({
  MANUAL:    'MANUAL',
  AUTOMATIC: 'AUTOMATIC',
  CVT:       'CVT',
  DCT:       'DCT',
});

export const DriveType = Object.freeze({
  FWD:    'FWD',
  RWD:    'RWD',
  AWD:    'AWD',
  FOUR_WD: '4WD',
});

export const BodyType = Object.freeze({
  SEDAN:       'SEDAN',
  SUV:         'SUV',
  HATCHBACK:   'HATCHBACK',
  PICKUP:      'PICKUP',
  VAN:         'VAN',
  COUPE:       'COUPE',
  CONVERTIBLE: 'CONVERTIBLE',
  WAGON:       'WAGON',
  MPV:         'MPV',
  MINIVAN:     'MINIVAN',
});

// ── Audit Event Types ─────────────────────────────────────────────────────────
// Ref: GBR-24
export const ActivityEventType = Object.freeze({
  // Auth
  USER_LOGIN:            'USER_LOGIN',
  USER_LOGOUT:           'USER_LOGOUT',
  LOGIN_FAILED:          'LOGIN_FAILED',
  ACCOUNT_LOCKED:        'ACCOUNT_LOCKED',
  PASSWORD_CHANGED:      'PASSWORD_CHANGED',
  PASSWORD_RESET:        'PASSWORD_RESET',
  CUSTOMER_REGISTERED:   'CUSTOMER_REGISTERED',
  GOOGLE_LINKED:         'GOOGLE_LINKED',
  PROFILE_COMPLETED:     'PROFILE_COMPLETED',

  // User Management
  USER_CREATED:          'USER_CREATED',
  USER_UPDATED:          'USER_UPDATED',
  USER_DEACTIVATED:      'USER_DEACTIVATED',
  USER_ACTIVATED:        'USER_ACTIVATED',

  // Vehicle
  CAR_CREATED:           'CAR_CREATED',
  CAR_UPDATED:           'CAR_UPDATED',
  CAR_STATUS_CHANGED:    'CAR_STATUS_CHANGED',
  CAR_PRICE_UPDATED:     'CAR_PRICE_UPDATED',
  CAR_IMAGE_ADDED:       'CAR_IMAGE_ADDED',
  CAR_IMAGE_REMOVED:     'CAR_IMAGE_REMOVED',

  // Customer & Lead
  CUSTOMER_CREATED:      'CUSTOMER_CREATED',
  CUSTOMER_UPDATED:      'CUSTOMER_UPDATED',
  LEAD_CREATED:          'LEAD_CREATED',
  LEAD_STAGE_CHANGED:    'LEAD_STAGE_CHANGED',
  LEAD_NOTE_ADDED:       'LEAD_NOTE_ADDED',

  // Appointments
  APPOINTMENT_CREATED:   'APPOINTMENT_CREATED',
  APPOINTMENT_CONFIRMED: 'APPOINTMENT_CONFIRMED',
  APPOINTMENT_CANCELLED: 'APPOINTMENT_CANCELLED',
  APPOINTMENT_COMPLETED: 'APPOINTMENT_COMPLETED',
});

// ── File Upload Constraints ───────────────────────────────────────────────────
// Ref: MSG32, MSG33
export const UPLOAD = Object.freeze({
  MAX_FILE_SIZE_BYTES:   5 * 1024 * 1024, // 5 MB
  ALLOWED_MIME_TYPES:    ['image/jpeg', 'image/png', 'image/webp'],
  MAX_IMAGES_PER_CAR:    20,
  ALLOWED_EXTENSIONS:    ['.jpg', '.jpeg', '.png', '.webp'],
});

// ── Pagination Defaults ───────────────────────────────────────────────────────
export const PAGINATION = Object.freeze({
  DEFAULT_PAGE:  1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT:     100,
});

// ── Appointment Scheduling Constraints ───────────────────────────────────────
// Ref: GBR-19
export const APPOINTMENT_CONSTRAINTS = Object.freeze({
  MIN_HOURS_AHEAD:     2,   // Must be at least 2 hours in the future
  MAX_DAYS_AHEAD:      60,  // Cannot schedule more than 60 days out
  CONFLICT_BUFFER_MIN: 30,  // ±30 minute buffer for conflict detection (GBR-20)
});
