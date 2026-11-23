/**
 * @file serviceRoutes.js
 * @description Showroom service CRUD routes (KAN-96).
 *
 * Mounted twice from src/routes/index.js:
 *   /public/services         (unauth, read-only via publicRouter)
 *   /manage/services         (verifyToken + service:* permissions via manageRouter)
 */

import { Router } from 'express';
import * as controller from '../controllers/showroomServiceController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { requirePermission } from '../middlewares/roleMiddleware.js';
import { validate, validateQuery, validateParams, objectIdParamSchema } from '../middlewares/validateMiddleware.js';
import { Permissions } from '../constants/appConstants.js';
import { createServiceSchema, updateServiceSchema, listServicesQuery } from './serviceSchemas.js';

// ── Public router (no auth) ────────────────────────────────────────────────
export const publicRouter = Router();
publicRouter.get('/', controller.listPublic);

// ── Manage router (verifyToken required) ──────────────────────────────────
export const manageRouter = Router();
manageRouter.use(verifyToken);

const canRead  = requirePermission(Permissions.SERVICE_READ);
const canWrite = requirePermission(Permissions.SERVICE_WRITE);
const byId     = validateParams(objectIdParamSchema);

manageRouter.get('/',    canRead,  validateQuery(listServicesQuery), controller.list);
manageRouter.get('/:id', canRead,  byId, controller.getOne);
manageRouter.post('/',   canWrite, validate(createServiceSchema),  controller.create);
manageRouter.put('/:id', canWrite, byId, validate(updateServiceSchema), controller.update);
manageRouter.delete('/:id', canWrite, byId, controller.remove);

export default { publicRouter, manageRouter };
