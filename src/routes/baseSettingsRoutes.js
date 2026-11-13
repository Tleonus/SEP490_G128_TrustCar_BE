import { Router } from 'express';
import * as controller from '../controllers/baseSettingsController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requireAdmin } from '../middlewares/roleMiddleware.js';
import { validate } from '../middlewares/validateMiddleware.js';
import { updateBaseSettingsSchema } from './baseSettingsSchemas.js';

const router = Router();

// Admin screen: GET current configuration and PUT the complete form payload.
router.use(verifyToken, requireAdmin);
router.get(['/base-settings', '/settings/base'], controller.getBaseSettings);
router.put(['/base-settings', '/settings/base'], validate(updateBaseSettingsSchema), controller.updateBaseSettings);

export default router;
