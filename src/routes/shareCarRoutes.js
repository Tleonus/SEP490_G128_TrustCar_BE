/**
 * @file shareCarRoutes.js
 * @description Public HTML share routes, mounted at the application root
 * rather than under /api/v1 because crawlers must receive text/html.
 */

import { Router } from 'express';
import { renderSharePage } from '../controllers/shareCarController.js';

const router = Router();

router.get('/share/car/:code', renderSharePage);

export default router;
