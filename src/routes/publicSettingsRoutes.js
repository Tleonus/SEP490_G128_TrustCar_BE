import { Router } from 'express';
import * as controller from '../controllers/baseSettingsController.js';

const router = Router();

// Public read-only configuration for homepage, contact page, footer and email templates.
router.get(['/base-settings', '/settings', '/settings/base'], controller.getBaseSettings);

export default router;
