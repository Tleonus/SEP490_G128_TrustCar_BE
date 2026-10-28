/**
 * @file app.js
 * @description Express application factory – composes all middleware, routes,
 * and error handlers into a single exportable Express instance.
 *
 * This file is DELIBERATELY separated from server.js so that:
 * 1. Integration tests can import the Express app without starting an HTTP server.
 * 2. The server.js entry point focuses solely on process lifecycle (DB, signals, listen).
 *
 * Middleware execution order (Chain of Responsibility):
 *   1. Helmet (security headers)
 *   2. CORS (cross-origin policy)
 *   3. Morgan (request logging)
 *   4. Rate limiter (global request throttle)
 *   5. JSON body parser
 *   6. URL-encoded parser
 *   7. API Routes (/api/v1/*)
 *   8. 404 Not Found handler
 *   9. Global Error handler
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

// Route aggregator
import apiRouter from './routes/index.js';

// Error handlers (MUST be last in the chain)
import { notFoundHandler, errorHandler } from './middlewares/errorMiddleware.js';

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESS INSTANCE
// ═══════════════════════════════════════════════════════════════════════════
const app = express();

// ── Trust proxy (for accurate req.ip behind Nginx / Railway / Render) ──────
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

// Helmet: Sets ~15 HTTP security headers (CSP, HSTS, X-Frame-Options, etc.)
app.use(helmet());

// CORS: Configurable allowed origins; defaults to permissive in dev
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : '*',
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:    true,
  maxAge:         86400, // 24 h preflight cache
};
app.use(cors(corsOptions));

// ═══════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════

// Morgan: Combined format in production, dev format otherwise
const logFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(logFormat, {
  skip: (req) => req.url === '/api/v1/health', // Suppress noisy health pings
}));

// ═══════════════════════════════════════════════════════════════════════════
// RATE LIMITING (Global)
// ═══════════════════════════════════════════════════════════════════════════

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,               // 15-minute window
  max:      parseInt(process.env.RATE_LIMIT_MAX, 10) || 200,  // max requests per window
  standardHeaders: true,                   // RateLimit-* headers
  legacyHeaders:   false,                  // Disable X-RateLimit-*
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
    code:    'RATE_LIMIT_EXCEEDED',
  },
});
app.use('/api/', globalLimiter);

// Auth endpoints get a stricter limiter to mitigate brute-force attacks (GBR-12)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
    code:    'AUTH_RATE_LIMIT',
  },
});
app.use('/api/v1/auth/', authLimiter);

// ═══════════════════════════════════════════════════════════════════════════
// BODY PARSERS
// ═══════════════════════════════════════════════════════════════════════════

app.use(express.json({ limit: '2mb' }));          // JSON payloads up to 2 MB
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All API routes are mounted under /api/v1 via the master router.
 * See src/routes/index.js for the full route map.
 */
app.use('/api/v1', apiRouter);

// ── Root redirect / API info ──────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'TrustCar Backend API',
    version: 'v1',
    docs:    '/api/v1/health',
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ERROR HANDLING (Must be last)
// ═══════════════════════════════════════════════════════════════════════════

// 404 catch-all for undefined routes
app.use(notFoundHandler);

// Global error handler (normalizes all errors to a consistent JSON envelope)
app.use(errorHandler);

export default app;
