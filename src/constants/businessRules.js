/**
 * @file businessRules.js
 * @description Formal Business Rules registry (GBR-01 to GBR-25).
 *
 * This file acts as a living contract between the product specification and the
 * implementation. Each rule documents:
 *   - id:          The unique rule identifier from the SRS.
 *   - title:       Short human-readable name.
 *   - description: Precise enforcement definition.
 *   - layer:       Where enforcement is implemented (Service / Middleware / Validation).
 *   - messages:    Related system message codes from systemMessages.js.
 *   - outOfScope:  Reference to charter limitation (LI-xx) if applicable.
 *
 * Usage: Import rules in Service files for inline commentary and test documentation.
 *        Validators may check rule objects for threshold values.
 */

export const BusinessRules = Object.freeze({

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP A – Authentication & Session Management
  // ════════════════════════════════════════════════════════════════════════════

  GBR_01: {
    id: 'GBR-01',
    title: 'JWT Bearer Authentication Required',
    description:
      'All non-public API endpoints require a valid, unexpired JWT Bearer token ' +
      'in the Authorization header. Tokens are short-lived (15 min access / 7 day refresh). ' +
      'Malformed or expired tokens return 401 Unauthorized.',
    layer: 'Middleware – authMiddleware.js (verifyToken)',
    messages: ['MSG01', 'MSG02', 'MSG03'],
  },

  GBR_02: {
    id: 'GBR-02',
    title: 'Role-Based Access Control (RBAC)',
    description: 'Every protected route declares one or more required permissions. The roleMiddleware resolves the requester's role -> permission set and denies access if the required permission is absent (403 Forbidden).',
    layer: 'Middleware - roleMiddleware.js (requirePermission)',
    messages: ['MSG04', 'MSG05'],
  },

  GBR_03: {
    id: 'GBR-03',
    title: 'Admin-Only User Provisioning',
    description:
      'Only accounts with the ADMIN role may create, deactivate, reactivate, ' +
      'or change the role of internal staff accounts. Self-deactivation is prohibited.',
    layer: 'Service – userService.js | Middleware – roleMiddleware.js',
    messages: ['MSG05', 'MSG16'],
  },

  GBR_12: {
    id: 'GBR-12',
    title: 'Brute-Force Account Locking (RETIRED)',
    description:
      'Retired 2026-10-24 (KAN-9): failed logins no longer lock the account. ' +
      'Every wrong email/password returns MSG07. Brute-force protection relies on ' +
      'the /api/v1/auth rate limiter (30 requests / 15 minutes / IP).',
    layer: 'Middleware – app.js (authLimiter)',
    retired: true,
    messages: ['MSG07'],
  },

  GBR_21: {
    id: 'GBR-21',
    title: 'Active Session Enforcement (Deactivated Account Rejection)',
    description:
      'After JWT verification, the authMiddleware performs a secondary database ' +
      'lookup to confirm isActive=true. Deactivated accounts are rejected (401) ' +
      'even when presenting a structurally valid, unexpired token.',
    layer: 'Middleware – authMiddleware.js (verifyToken)',
    messages: ['MSG06'],
  },

  GBR_22: {
    id: 'GBR-22',
    title: 'Password Complexity Policy',
    description:
      'Passwords must be 8-128 characters and contain at minimum: ' +
      '1 uppercase letter, 1 lowercase letter, 1 digit. Only Latin letters, digits and ' +
      'the special characters !@#$%^&*-_=+ are allowed (special characters optional). ' +
      'Enforced at the DTO validation layer before the service.',
    layer: 'Validation – validators.js (passwordSchema) | Joi DTO schemas',
    messages: ['MSG12'],
  },

  GBR_23: {
    id: 'GBR-23',
    title: 'Self-Profile Read / Own Password Change Only',
    description:
      'A staff member may only read their own profile and change their own ' +
      'password. Reading or modifying another user's account requires ADMIN role.',
    layer: 'Controller – authController.js | Service – authService.js',
    messages: ['MSG05'],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP B – Vehicle Inventory Management
  // ════════════════════════════════════════════════════════════════════════════

  GBR_04: {
    id: 'GBR-04',
    title: 'Unique VIN per Vehicle',
    description:
      'Each vehicle record must carry a globally unique 17-character VIN (ISO 3779). ' +
      'On intake (create) and update the service checks for VIN collisions across all ' +
      'non-DELISTED records. Duplicate VINs return 409 Conflict.',
    layer: 'Service – carService.js (assertVinUnique)',
    messages: ['MSG20'],
  },

  GBR_05: {
    id: 'GBR-05',
    title: 'Vehicle Status State Machine',
    description:
      'Vehicle status changes are validated against CAR_STATUS_TRANSITIONS. ' +
      'Invalid transitions (e.g., SOLD → AVAILABLE) return 422 Unprocessable Entity. ' +
      'Terminal states SOLD and DELISTED accept no further transitions.',
    layer: 'Service – carService.js (transitionStatus)',
    messages: ['MSG21', 'MSG22'],
  },

  GBR_06: {
    id: 'GBR-06',
    title: 'Sold Vehicle – Read-Only Lock',
    description:
      'Once a vehicle reaches SOLD status all field modifications (except reading ' +
      'price history) are rejected with 403 Forbidden. The record becomes an ' +
      'immutable historical reference.',
    layer: 'Service – carService.js (assertNotSold)',
    messages: ['MSG23'],
  },

  GBR_07: {
    id: 'GBR-07',
    title: 'Price History Immutability (Append-Only)',
    description:
      'Every price change appends a new PriceHistory entry ' +
      '{ price, changedBy, changedAt, reason } to the vehicle's priceHistory array. ' +
      'Existing entries cannot be modified or removed via any API.',
    layer: 'Service – carService.js (updatePrice)',
    messages: ['MSG24'],
  },

  GBR_08: {
    id: 'GBR-08',
    title: 'License Plate Active-Inventory Uniqueness',
    description:
      'Vietnamese license plate numbers must be unique across vehicles whose status is ' +
      'INCOMING, MAINTENANCE, AVAILABLE, or RESERVED. SOLD and DELISTED records are ' +
      'excluded from the uniqueness check to allow historical re-registration.',
    layer: 'Service – carService.js (assertPlateUnique)',
    messages: ['MSG25'],
  },

  GBR_09: {
    id: 'GBR-09',
    title: 'Odometer Reading Cannot Decrease',
    description:
      'When updating a vehicle's mileage (ODO), the new value must be ≥ the currently ' +
      'stored value. Decreasing mileage readings return 422 Unprocessable Entity.',
    layer: 'Service – carService.js (assertMileageNotDecreased)',
    messages: ['MSG26'],
  },

  GBR_10: {
    id: 'GBR-10',
    title: 'Production Year Validation',
    description:
      'Vehicle manufacturing year must fall within [1990, currentYear + 1]. ' +
      'Values outside this range are rejected at the DTO validation layer.',
    layer: 'Validation – DTO schema (Joi)',
    messages: ['MSG27'],
  },

  GBR_11: {
    id: 'GBR-11',
    title: 'Public Catalog – AVAILABLE Vehicles Only',
    description:
      'The public browsing APIs (FE-01, FE-02, FE-03) must only expose vehicles with ' +
      'status=AVAILABLE regardless of any filter parameters supplied by the caller.',
    layer: 'Service – publicCarService.js (getAvailableCars)',
    messages: [],
  },

  GBR_13: {
    id: 'GBR-13',
    title: 'Vehicle Code Auto-Generation',
    description:
      'Each new vehicle intake generates a unique vehicleCode in the format ' +
      'TC-YYYY-NNNN (e.g., TC-2024-0001) using the codeGenerator utility. ' +
      'The code is immutable after creation.',
    layer: 'Service – carService.js | Utility – codeGenerator.js',
    messages: [],
  },

  GBR_14: {
    id: 'GBR-14',
    title: 'Primary Image Constraint',
    description:
      'A vehicle may have at most one image marked isPrimary=true. ' +
      'Setting a new primary image automatically demotes the previous one.',
    layer: 'Service – carService.js (setPrimaryImage)',
    messages: ['MSG28'],
  },

  GBR_15: {
    id: 'GBR-15',
    title: 'Image Upload Limit per Vehicle',
    description:
      `A vehicle record may hold at most UPLOAD.MAX_IMAGES_PER_CAR (20) images. ` +
      'Attempting to add images beyond this limit returns 422.',
    layer: 'Service – carService.js | Middleware – uploadMiddleware.js',
    messages: ['MSG29'],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP C – Customer & Lead Management
  // ════════════════════════════════════════════════════════════════════════════

  GBR_16: {
    id: 'GBR-16',
    title: 'Customer Phone Normalization & Soft-Uniqueness',
    description:
      'Vietnamese phone numbers are normalized to the 10-digit format (0xxxxxxxxx) ' +
      'before persistence. Duplicate phone numbers trigger a soft-match warning response ' +
      '(HTTP 200 with existingCustomerId) rather than a hard rejection, allowing staff ' +
      'to decide whether to reuse the existing record.',
    layer: 'Service – customerService.js | Utility – validators.js',
    messages: ['MSG30'],
  },

  GBR_17: {
    id: 'GBR-17',
    title: 'Lead Stage Forward-Only Progression',
    description:
      'Lead stages follow LEAD_STAGE_TRANSITIONS (forward-only). ' +
      'Backward transitions (e.g., NEGOTIATING → CONTACTED) are prohibited ' +
      'except transitions to LOST, which is allowed from any active stage.',
    layer: 'Service – leadService.js (transitionStage)',
    messages: ['MSG31'],
  },

  GBR_18: {
    id: 'GBR-18',
    title: 'Lead Activity Log – Append Only',
    description:
      'LeadActivity entries (notes, calls, emails logged against a lead) are append-only. ' +
      'No API endpoint permits updating or deleting past activity entries. ' +
      'This preserves an immutable interaction history.',
    layer: 'Service – leadService.js | Model – Lead.js',
    messages: [],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP D – Appointments
  // ════════════════════════════════════════════════════════════════════════════

  GBR_19: {
    id: 'GBR-19',
    title: 'Appointment Scheduling Window',
    description:
      'Appointments must be at least APPOINTMENT_CONSTRAINTS.MIN_HOURS_AHEAD (2 h) ' +
      'in the future and no more than APPOINTMENT_CONSTRAINTS.MAX_DAYS_AHEAD (60 days) ahead. ' +
      'Past-date bookings return 422.',
    layer: 'Service – appointmentService.js (validateScheduledAt)',
    messages: ['MSG35', 'MSG36'],
  },

  GBR_20: {
    id: 'GBR-20',
    title: 'No Overlapping Vehicle Appointments',
    description:
      'A vehicle cannot have two CONFIRMED or PENDING appointments within ' +
      'APPOINTMENT_CONSTRAINTS.CONFLICT_BUFFER_MIN (±30 min) of each other. ' +
      'Conflict detection is vehicle-scoped, not staff-scoped.',
    layer: 'Service – appointmentService.js (assertNoConflict)',
    messages: ['MSG37'],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // GROUP E – Audit, Compliance & Data Retention
  // ════════════════════════════════════════════════════════════════════════════

  GBR_24: {
    id: 'GBR-24',
    title: 'Immutable Audit Trail (ActivityLog)',
    description:
      'All create, update, status-change, and deletion (soft) operations must ' +
      'write an immutable ActivityLog document capturing: eventType, performedBy, ' +
      'targetModel, targetId, changes (before/after snapshot), ipAddress, userAgent, ' +
      'and createdAt. ActivityLog records are never modified or hard-deleted.',
    layer: 'Service layer (all services) | Model – ActivityLog.js',
    messages: ['MSG40'],
  },

  GBR_25: {
    id: 'GBR-25',
    title: 'Soft Delete / Data Retention Policy',
    description:
      'No entity is hard-deleted from the database. Records are soft-deleted by setting ' +
      'isActive=false (users, customers, leads, appointments) or status=DELISTED (vehicles). ' +
      'Physical deletion via any public API endpoint is prohibited.',
    layer: 'Service layer (all services)',
    messages: ['MSG41'],
  },

  // ════════════════════════════════════════════════════════════════════════════
  // OUT-OF-SCOPE BOUNDARIES (Charter Limitations) – Reference Only
  // ════════════════════════════════════════════════════════════════════════════

  LI_01: {
    id: 'LI-01',
    title: '[OUT OF SCOPE] Vehicle Delivery & Transport',
    description: 'Delivery dispatching, shipping tracking, and transport logistics are excluded.',
    outOfScope: true,
  },
  LI_03: {
    id: 'LI-03',
    title: '[OUT OF SCOPE] Online Payments, Deposits & Refunds',
    description: 'Payment gateways, wallet integrations, and refund workflows are excluded.',
    outOfScope: true,
  },
  LI_04: {
    id: 'LI-04',
    title: '[OUT OF SCOPE] Legal Contracts & Title Transfer',
    description: 'Document generation, registration paperwork, and title handling are excluded.',
    outOfScope: true,
  },
  LI_05: {
    id: 'LI-05',
    title: '[OUT OF SCOPE] Garage Execution & Repair Orders',
    description:
      'Mechanical work orders, spare-parts inventory, technician dispatching are excluded. ' +
      'Maintenance BOOKING (scheduling intake) is in scope per FE-07.',
    outOfScope: true,
  },
});

export default BusinessRules;
