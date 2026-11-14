/**
 * @file inventoryRoutes.js
 * @description Router for inventory aging and markdown execution.
 */

import { Router } from 'express';
import * as inventoryController from '../controllers/inventoryController.js';
import { verifyToken as authMiddleware } from '../middlewares/authMiddleware.js';

const router = Router();

// All inventory routes require authentication (staff/admin)
router.use(authMiddleware);

// GET /api/v1/inventory/aging
router.get('/aging', inventoryController.getAgingCars);

// POST /api/v1/inventory/aging/execute-markdown
router.post('/aging/execute-markdown', inventoryController.executeMarkdown);

export default router;
