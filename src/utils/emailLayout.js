/**
 * @file emailLayout.js
 * @description Shared TrustCar branded email layout (black / navy / gray + logo).
 * `sendMail` wraps every outgoing body with it, so callers only write content.
 *
 * Email clients ignore <style> blocks and external CSS inconsistently, so the
 * layout uses tables + inline styles only. The logo must be a public absolute
 * URL (Gmail/Outlook block data: URIs and SVG).
 */

const COLORS = {
  page:    '#0b0f19', // near-black outer background
  card:    '#111a2e', // navy card
  header:  '#0a1428', // deep navy header band
  border:  '#1f2a44',
  text:    '#e2e8f0',
  muted:   '#94a3b8', // gray secondary text
  accent:  '#3b9fe0', // brand blue (matches site CTA)
};

const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Default matches the Vite dev server; set FRONTEND_URL for other environments.
export const frontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
const logoUrl = () => process.env.MAIL_LOGO_URL || `${frontendUrl()}/email-logo.png`;

const escapeAttr = (value = '') =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

/**
 * Bulletproof CTA button for use inside email bodies.
 * @param {string} label - Button text (escaped).
 * @param {string} url   - Absolute link (escaped).
 */
export const emailButton = (label, url) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr><td style="border-radius:8px;background:${COLORS.accent};">
      <a href="${escapeAttr(url)}" target="_blank"
         style="display:inline-block;padding:12px 28px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
        ${escapeAttr(label)}
      </a>
    </td></tr>
  </table>`;

/**
 * Wraps body HTML in the branded layout.
 * @param {Object} options
 * @param {string} options.subject     - Used as <title> (escaped).
 * @param {string} options.contentHtml - Trusted body HTML; caller escapes user data.
 * @param {string} [options.preheader] - Inbox preview text (escaped).
 * @returns {string} Full HTML document.
 */
export const renderEmailLayout = ({ subject, contentHtml, preheader = '' }) => {
  const year = new Date().getFullYear();
  const site = frontendUrl();

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <title>${escapeAttr(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeAttr(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.page};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:14px;overflow:hidden;">

        <!-- Header: logo + wordmark on deep navy -->
        <tr><td style="background:${COLORS.header};padding:24px 32px;border-bottom:3px solid ${COLORS.accent};">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="vertical-align:middle;">
              <a href="${escapeAttr(site)}" target="_blank">
                <img src="${escapeAttr(logoUrl())}" width="56" height="56" alt="TrustCar"
                     style="display:block;border:0;border-radius:10px;">
              </a>
            </td>
            <td style="vertical-align:middle;padding-left:14px;font-family:${FONT};">
              <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">TrustCar</div>
              <div style="font-size:12px;color:${COLORS.muted};">Mua xe cũ, an tâm như xe mới</div>
            </td>
          </tr></table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;font-family:${FONT};font-size:15px;line-height:1.65;color:${COLORS.text};">
          ${contentHtml}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;border-top:1px solid ${COLORS.border};font-family:${FONT};font-size:12px;line-height:1.6;color:${COLORS.muted};">
          Email này được gửi tự động từ TrustCar, vui lòng không trả lời.<br>
          <a href="${escapeAttr(site)}" target="_blank" style="color:${COLORS.accent};text-decoration:none;">${escapeAttr(site.replace(/^https?:\/\//, ''))}</a>
          &nbsp;·&nbsp; © ${year} TrustCar
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
};

export default { renderEmailLayout, emailButton };
