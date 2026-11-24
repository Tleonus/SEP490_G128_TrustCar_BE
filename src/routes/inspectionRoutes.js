import { wireInspection } from '../infra/inspection/wireInspection.js';
import { createInspectionRouter } from '../interface/inspection/inspectionRouter.js';
import { verifyToken } from '../middlewares/authMiddleware.js';

export default createInspectionRouter({ useCases: wireInspection(), authenticate: verifyToken });
