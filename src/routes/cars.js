import { Router } from 'express';
import Car from '../models/Car.js';
import { CarStatus } from '../constants/appConstants.js';

const router = Router();

/**
 * @route   GET /api/v1/cars/featured
 * @desc    Returns a limited list of featured cars (status AVAILABLE or APPROVED_CPO), sorted by newest.
 * @access  Public (no authentication required)
 */
router.get('/featured', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 8;
    const cars = await Car.find({
      status: { $in: [CarStatus.AVAILABLE, CarStatus.APPROVED_CPO] },
      isActive: true,
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ success: true, data: cars });
  } catch (err) {
    next(err);
  }
});

export default router;
