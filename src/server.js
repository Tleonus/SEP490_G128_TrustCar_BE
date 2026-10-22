/**
 * @file server.js
 * @description Application entry point – handles process lifecycle:
 *   1. Load environment variables (dotenv)
 *   2. Connect to MongoDB (singleton)
 *   3. Configure Cloudinary (singleton)
 *   4. Seed default Roles and Admin account
 *   5. Start the HTTP server
 *   6. Graceful shutdown on SIGTERM / SIGINT
 *
 * This file is deliberately thin – all Express wiring lives in app.js.
 */

import 'dotenv/config'; // Load .env FIRST, before any module reads process.env

import app from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { configureCloudinary } from './config/cloudinary.js';
import Role from './models/Role.js';
import { seedAdminAccount } from './seeders/adminSeeder.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const PORT = parseInt(process.env.PORT, 10) || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════

const startServer = async () => {
  try {
    // 1. Connect to MongoDB
    console.log('🔌  Connecting to MongoDB...');
    await connectDB();

    // 2. Configure Cloudinary SDK
    configureCloudinary();

    // 3. Seed default roles (ADMIN, SALES_STAFF) if not present
    await Role.seedDefaultRoles();

    // 4. Seed initial admin account if no admin exists
    await seedAdminAccount();

    // 5. Start HTTP server
    const server = app.listen(PORT, () => {
      console.log('════════════════════════════════════════════════════');
      console.log(`🚀  TrustCar API Server running on port ${PORT}`);
      console.log(`📍  Environment: ${NODE_ENV}`);
      console.log(`🔗  Health:  http://localhost:${PORT}/api/v1/health`);
      console.log(`🔗  API:     http://localhost:${PORT}/api/v1`);
      console.log('════════════════════════════════════════════════════');
    });

    // ── Graceful Shutdown ─────────────────────────────────────────────────
    const shutdown = async (signal) => {
      console.log(`\n⏳  ${signal} received. Graceful shutdown initiated...`);

      // Stop accepting new connections
      server.close(async () => {
        console.log('🛑  HTTP server closed.');

        // Close database connection
        await disconnectDB();
        console.log('✅  Shutdown complete. Exiting.');
        process.exit(0);
      });

      // Force exit if graceful shutdown takes too long (10s)
      setTimeout(() => {
        console.error('⚠️  Graceful shutdown timed out (10s). Forcing exit.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // ── Unhandled Rejections & Exceptions ────────────────────────────────
    process.on('unhandledRejection', (reason) => {
      console.error('💥  Unhandled Rejection:', reason);
      // Let the process crash so the orchestrator restarts it cleanly
      shutdown('UNHANDLED_REJECTION');
    });

    process.on('uncaughtException', (error) => {
      console.error('💥  Uncaught Exception:', error);
      process.exit(1); // Immediate exit for uncaught exceptions
    });

  } catch (error) {
    console.error('❌  Startup failed:', error.message);
    process.exit(1);
  }
};

startServer();
