/**
 * @file vehicleHistoryRoutes.js
 * @description Public KAN-98 routes mounted under /api/v1/public.
 *
 *   GET /history/:code/pdf  → multi-page vehicle history PDF
 *   GET /verify/:hash       → QR verify summary (JSON)
 *
 * The PDF route is rate-limited; the verify route is cheap and rides the
 * global limiter.
 */

import { Router } from 'express';
import * as vehicleHistoryController from '../controllers/vehicleHistoryController.js';
import { createHistoryPdfLimiter } from '../middlewares/rateLimiters.js';

const router = Router();

router.get('/history/:code/pdf', createHistoryPdfLimiter(), vehicleHistoryController.getVehicleHistoryPdf);
router.get('/verify/:hash', vehicleHistoryController.getVerifySummary);

export default router;
