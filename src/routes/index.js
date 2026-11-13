/**
 * @file index.js
 * @description Master API Router – mounts all sub-routers under /api/v1.
 *
 * Route structure:
 *   /api/v1/health          → Health & readiness probes
 *   /api/v1/auth            → Authentication (login, logout, profile, password)
 *   /api/v1/users           → Staff account management (Admin only)
 *   /api/v1/manage/cars     → Vehicle inventory CRUD (Staff & Admin)
 *   /api/v1/public/cars     → Public vehicle catalog (unauthenticated)
 *   /api/v1/customer/appointments → Customer test-drive booking (CUSTOMER)
 *   /api/v1/appointments    → Test-drive appointment handling (Staff & Admin)
 *
 * Adding new feature routes:
 * 1. Create src/routes/featureRoutes.js
 * 2. Import it here and mount under the appropriate path
 * 3. No other files need modification for route registration
 */

import { Router } from 'express';
import healthController  from '../controllers/healthController.js';
import authRoutes        from './authRoutes.js';
import userRoutes        from './userRoutes.js';
import carRoutes         from './carRoutes.js';
import publicCarRoutes   from './publicCarRoutes.js';
import inventoryRoutes   from './inventoryRoutes.js';
import inspectionRoutes  from './inspectionRoutes.js';
import customerCarRoutes from './customerCarRoutes.js';
import customerAppointmentRoutes from './customerAppointmentRoutes.js';
import appointmentRoutes from './appointmentRoutes.js';
import baseSettingsRoutes   from './baseSettingsRoutes.js';
import publicSettingsRoutes from './publicSettingsRoutes.js';
import wishlistRoutes       from './wishlistRoutes.js';
import publicWishlistRoutes from './publicWishlistRoutes.js';
import testDriveRoutes      from './testDriveRoutes.js';
import leadPublicRoutes     from './leadPublicRoutes.js';
import leadRoutes           from './leadRoutes.js';
import emailLogRoutes       from './emailLogRoutes.js';
import marketingRoutes      from './marketingRoutes.js';
import loanSettingsRoutes   from './loanSettingsRoutes.js';

const router = Router();

// ── Health Probes ──────────────────────────────────────────────────────────
router.get('/health',       healthController.liveness);
router.get('/health/ready', healthController.readiness);

// ── Auth ──────────────────────────────────────────────────────────────────
router.use('/auth', authRoutes);

// ── Internal Staff Management (Admin only) ─────────────────────────────────
router.use('/users', userRoutes);

// ── Protected Inventory Management (Staff & Admin) ─────────────────────────
router.use('/manage/cars', carRoutes);

// ── Public Catalog (No Auth) ───────────────────────────────────────────────
router.use('/public/cars', publicCarRoutes);
router.use('/public/wishlist', publicWishlistRoutes);
router.use('/public', publicSettingsRoutes);
router.use('/settings', loanSettingsRoutes);

// ── Inventory Aging & Markdown (Staff & Admin) ───────────────────────────
router.use('/inventory', inventoryRoutes);

// ── Car Inspection Workflow & Approval Engine (Inspector & Admin) ─────────
router.use('/inspections', inspectionRoutes);

// ── Customer-only Vehicle Comparison (CUSTOMER role) ───────────────────────
router.use('/customer/cars', customerCarRoutes);
router.use('/customer/wishlist', wishlistRoutes);
router.use('/admin', baseSettingsRoutes);
router.use('/admin', emailLogRoutes);

// ── Test-Drive Booking (Customer, Staff & Admin) ───────────────────────────
router.use('/test-drives', testDriveRoutes);

// ── Lead Pipeline ─────────────────────────────────────────────────────────// Public intake first: it only owns POST /, so it must not shadow the
// authenticated router's GET /:id. See leadPublicRoutes.js.
router.use('/leads', leadPublicRoutes);
router.use('/leads', leadRoutes);

// ── Marketing Tooling (Admin & Sales staff) ────────────────────────────────
router.use('/marketing', marketingRoutes);

// ── Test-drive Booking: customer side (CUSTOMER) and staff side (Staff & Admin) ──
router.use('/customer/appointments', customerAppointmentRoutes);
router.use('/appointments', appointmentRoutes);

export default router;
