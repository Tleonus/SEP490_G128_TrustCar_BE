/**
 * @file vehicleHistoryController.js
 * @description Public endpoints for the KAN-98 Vehicle History Report.
 * No authentication — the hash in the URL is the authorisation.
 */

import * as vehicleHistoryService from '../services/vehicleHistoryService.js';
import { renderVehicleHistoryPdf } from '../services/vehicleHistoryPdf.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route   GET /api/v1/public/history/:code/pdf
 * @access  Public
 * @desc    Multi-page vehicle history PDF for a certified car.
 */
export const getVehicleHistoryPdf = async (req, res, next) => {
  try {
    const report = await vehicleHistoryService.getHistoryReport(req.params.code);
    const pdf = renderVehicleHistoryPdf(report);
    const fileName = `lich-su-${report.vehicle?.vehicleCode || 'xe'}.pdf`;
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${fileName}"`);
    return res.status(200).send(pdf);
  } catch (error) {
    return next(error);
  }
};

/**
 * @route   GET /api/v1/public/verify/:hash
 * @access  Public
 * @desc    Summary returned to the QR verify page. 404 for every bad case.
 */
export const getVerifySummary = async (req, res, next) => {
  try {
    const summary = await vehicleHistoryService.getVerifySummary(req.params.hash);
    return sendSuccess(res, 200, 'Verification summary retrieved successfully.', summary);
  } catch (error) {
    return next(error);
  }
};

export default { getVehicleHistoryPdf, getVerifySummary };
