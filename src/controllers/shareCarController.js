/**
 * @file shareCarController.js
 * @description Renders the HTML Open Graph preview for a shared vehicle (KAN-64).
 *
 * The response is text/html, never JSON: crawlers read the meta tags, and a
 * human visitor is bounced to the front-end detail page by a meta refresh
 * plus a script fallback.
 */

import * as shareCarService from '../services/shareCarService.js';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const meta = (property, content) => (
  content ? `<meta property="${property}" content="${escapeHtml(content)}">` : ''
);

const nameMeta = (name, content) => (
  content ? `<meta name="${name}" content="${escapeHtml(content)}">` : ''
);

/**
 * HTML document the crawler reads. Exported so the markup can be tested
 * without booting the app (importing app.js pulls in firebase-admin).
 *
 * @param {object} preview - Output of shareCarService.getSharePreview.
 * @returns {string}
 */
export const renderPreview = ({ title, description, image, shareUrl, redirectUrl }) => `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} | TrustCar</title>
${meta('og:title', title)}
${meta('og:description', description)}
${meta('og:image', image)}
${image ? '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' : ''}
${meta('og:url', shareUrl)}
<meta property="og:type" content="product">
<meta property="og:site_name" content="TrustCar">
<meta name="twitter:card" content="summary_large_image">
${nameMeta('twitter:title', title)}
${nameMeta('twitter:description', description)}
${nameMeta('twitter:image', image)}
<meta name="description" content="${escapeHtml(description)}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(redirectUrl)}">
<link rel="canonical" href="${escapeHtml(redirectUrl)}">
</head>
<body>
<p>Đang chuyển đến trang xe… <a href="${escapeHtml(redirectUrl)}">Bấm vào đây nếu không tự chuyển.</a></p>
<script>location.replace(${JSON.stringify(redirectUrl)});</script>
</body>
</html>`;

const renderUnavailable = () => `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Xe không còn | TrustCar</title>
<meta name="robots" content="noindex">
</head>
<body>
<p>Xe này không còn hoặc không tồn tại.</p>
</body>
</html>`;

/**
 * @route  GET /share/car/:code
 * @access Public
 */
export const renderSharePage = async (req, res, next) => {
  try {
    const preview = await shareCarService.getSharePreview(req.params.code);
    preview.shareUrl = shareCarService.sharePageUrl(preview.vehicleCode, req);
    res.status(200).type('html').send(renderPreview(preview));
  } catch (error) {
    if (error.statusCode === 404) {
      res.status(404).type('html').send(renderUnavailable());
      return;
    }
    next(error);
  }
};

export default { renderSharePage };
