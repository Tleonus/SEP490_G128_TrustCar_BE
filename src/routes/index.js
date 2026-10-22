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

export default router;
