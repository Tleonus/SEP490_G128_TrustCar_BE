// src/utils/logger.js
/**
 * Minimal logger stub used by background jobs and services.
 * Exposes the common methods: info, warn, error.
 * In production you may replace this with winston, pino, etc.
 */

const logger = {
  info: (...args) => console.info('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

export default logger;
export { logger };
