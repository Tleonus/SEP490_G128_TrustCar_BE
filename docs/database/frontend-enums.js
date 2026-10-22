/**
 * Toàn bộ enum của TrustCar (sinh từ ERD).
 * Giá trị ERD không ghi (stage, status, type...) là tự đề xuất — chỉnh lại cho khớp quy trình thật.
 */
export const AuthProvider = Object.freeze({ LOCAL: 'LOCAL', FIREBASE: 'FIREBASE' });
export const ProfileSource = Object.freeze({ FORM: 'FORM', AI: 'AI', STAFF: 'STAFF' });
export const InterestType = Object.freeze({ VIEW: 'VIEW', COMPARE: 'COMPARE', SAVED: 'SAVED', ASKED: 'ASKED' });
export const SenderType = Object.freeze({ CUSTOMER: 'CUSTOMER', AI: 'AI', STAFF: 'STAFF', SYSTEM: 'SYSTEM' });
export const AgingCategory = Object.freeze({ FRESH: 'FRESH', SLOW: 'SLOW', STAGNANT: 'STAGNANT' });
export const InventoryType = Object.freeze({ OWNED: 'OWNED', CONSIGNMENT: 'CONSIGNMENT' });
export const FeedbackStatus = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' });
export const RecordStatus = Object.freeze({ ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' });
export const UserStatus = Object.freeze({ ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE', LOCKED: 'LOCKED' });
export const LeadStage = Object.freeze({ NEW: 'NEW', CONTACTED: 'CONTACTED', QUALIFIED: 'QUALIFIED', NEGOTIATING: 'NEGOTIATING', WON: 'WON', LOST: 'LOST' });
export const PriorityBand = Object.freeze({ HOT: 'HOT', WARM: 'WARM', COLD: 'COLD' });
export const LeadTaskStatus = Object.freeze({ PENDING: 'PENDING', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED' });
export const AppointmentType = Object.freeze({ VIEW_CAR: 'VIEW_CAR', TEST_DRIVE: 'TEST_DRIVE', SERVICE: 'SERVICE', VALUATION: 'VALUATION' });
export const AppointmentStatus = Object.freeze({ REQUESTED: 'REQUESTED', CONFIRMED: 'CONFIRMED', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', NO_SHOW: 'NO_SHOW' });
export const SaleStatus = Object.freeze({ COMPLETED: 'COMPLETED', VOIDED: 'VOIDED' });
export const ConversationStatus = Object.freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED' });
export const ConsentState = Object.freeze({ PENDING: 'PENDING', ACCEPTED: 'ACCEPTED', DECLINED: 'DECLINED' });
export const ContentStatus = Object.freeze({ DRAFT: 'DRAFT', PUBLISHED: 'PUBLISHED', HIDDEN: 'HIDDEN' });
export const CarStatus = Object.freeze({ AVAILABLE: 'AVAILABLE', RESERVED: 'RESERVED', SOLD: 'SOLD', HIDDEN: 'HIDDEN' });
export const BodyType = Object.freeze({ SEDAN: 'SEDAN', SUV: 'SUV', HATCHBACK: 'HATCHBACK', MPV: 'MPV', PICKUP: 'PICKUP', COUPE: 'COUPE', CONVERTIBLE: 'CONVERTIBLE', OTHER: 'OTHER' });
export const FuelType = Object.freeze({ PETROL: 'PETROL', DIESEL: 'DIESEL', HYBRID: 'HYBRID', ELECTRIC: 'ELECTRIC' });
export const Transmission = Object.freeze({ AUTOMATIC: 'AUTOMATIC', MANUAL: 'MANUAL' });
