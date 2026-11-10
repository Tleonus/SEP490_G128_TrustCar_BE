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

// ── Inventory Aging & Markdown (Staff & Admin) ───────────────────────────
router.use('/inventory', inventoryRoutes);

// ── Car Inspection Workflow & Approval Engine (Inspector & Admin) ─────────
router.use('/inspections', inspectionRoutes);

// ── Customer-only Vehicle Comparison (CUSTOMER role) ───────────────────────
router.use('/customer/cars', customerCarRoutes);

// ── Test-drive Booking: customer side (CUSTOMER) and staff side (Staff & Admin) ──
router.use('/customer/appointments', customerAppointmentRoutes);
router.use('/appointments', appointmentRoutes);

export default router;
