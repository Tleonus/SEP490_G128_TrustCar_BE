/**
 * @file facebookPublishController.js
 * @description Đăng bài xe lên Facebook Page (KAN-91). Thin: validate ở route schema,
 * nghiệp vụ trong facebookPublishService.
 */

import * as facebookPublishService from '../services/facebookPublishService.js';
import { sendSuccess } from '../utils/apiResponse.js';

/**
 * @route  POST /api/v1/marketing/facebook/publish
 * @access Admin
 * @body   { carId, caption, imageUrl? }
 * @desc   Đăng ảnh + caption lên Facebook Page đã cấu hình, trả postId và link bài viết.
 */
export const publishCarPost = async (req, res, next) => {
  try {
    const { carId, caption, imageUrl } = req.body;
    const result = await facebookPublishService.publishCarPost({
      carId,
      caption,
      imageUrl: imageUrl || null,
      userId: req.userId,
      ipAddress: req.ip,
    });
    return sendSuccess(res, 201, 'Post published to the Facebook Page successfully.', result);
  } catch (error) {
    next(error);
  }
};

export default { publishCarPost };
