// src/controllers/inventoryController.js
/**
 * @file inventoryController.js
 * @description Controller for inventory aging and markdown execution.
 */

import { sendSuccess, sendError } from '../utils/apiResponse.js';
import * as inventoryService from '../services/inventoryService.js';

/**
 * GET /api/v1/inventory/aging
 * Returns list of cars with aging info. Supports optional `status` query param.
 */
export const getAgingCars = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const cars = await inventoryService.listAgingCars(filter);
    return sendSuccess(res, 200, 'Aging inventory retrieved.', cars);
  } catch (err) {
    return sendError(res, err.statusCode || 500, err.message || 'Server error', err.code);
  }
};

/**
 * POST /api/v1/inventory/aging/execute-markdown
 * Body may contain `carIds` array (optional). If omitted, all eligible cars are processed.
 */
export const executeMarkdown = async (req, res) => {
  try {
    const { carIds } = req.body || {};
    const userId = req.userId;
    const results = await inventoryService.executeMarkdown(carIds, userId);
    return sendSuccess(res, 200, 'Markdown execution completed.', results);
  } catch (err) {
    return sendError(res, err.statusCode || 500, err.message || 'Server error', err.code);
  }
};

export default {
  getAgingCars,
  executeMarkdown,
};
