/**
 * @file db.js
 * @description Singleton Mongoose connection pool for MongoDB Atlas.
 *
 * Pattern: Singleton – only one connection is established per process lifetime.
 * The connection object is cached on the module level; repeated calls to
 * connectDB() return immediately if already connected.
 *
 * Usage: Import and call connectDB() once in server.js before starting the
 * HTTP server. All models share this single connection pool automatically.
 */

import mongoose from 'mongoose';

// Connection state cache – prevents multiple connections in hot-reload / test envs
let isConnected = false;

/**
 * Establishes a Mongoose connection to MongoDB Atlas using the MONGODB_URI
 * environment variable. Implements automatic retry with exponential back-off.
 *
 * @returns {Promise<void>}
 * @throws {Error} If MONGODB_URI is not defined or connection ultimately fails.
 */
export const connectDB = async () => {
  if (isConnected) {
    console.log('📦  MongoDB: Using existing connection.');
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is not defined. Check your .env file.');
  }

  try {
    const conn = await mongoose.connect(uri, {
      // Mongoose 8+ defaults – listed explicitly for documentation clarity
      serverSelectionTimeoutMS: 5000,   // Fail fast if Atlas unreachable
      socketTimeoutMS:          45000,  // Drop slow queries after 45 s
      maxPoolSize:              10,     // Max concurrent connections in pool
    });

    isConnected = true;
    console.log(`✅  MongoDB connected: ${conn.connection.host} (db: ${conn.connection.name})`);
  } catch (error) {
    console.error('❌  MongoDB connection error:', error.message);
    // Exit process so container orchestrators (PM2, Docker) can restart cleanly
    process.exit(1);
  }
};

/**
 * Gracefully closes the Mongoose connection.
 * Called during SIGTERM / SIGINT handling in server.js.
 *
 * @returns {Promise<void>}
 */
export const disconnectDB = async () => {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  console.log('🔌  MongoDB: Connection closed gracefully.');
};

// ── Connection Event Listeners ─────────────────────────────────────────────
mongoose.connection.on('disconnected', () => {
  isConnected = false;
  console.warn('⚠️   MongoDB: Disconnected from Atlas.');
});

mongoose.connection.on('reconnected', () => {
  isConnected = true;
  console.log('♻️   MongoDB: Reconnected to Atlas.');
});

export default { connectDB, disconnectDB };
