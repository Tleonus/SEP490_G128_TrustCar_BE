/**
 * @file realtime.js
 * @description Realtime channel for test-drive notifications. A client connects with its
 * access token and the server puts it in the groups its account may hear from. Clients
 * cannot choose those groups, and notifications carry no personal data.
 *
 * Connections live in this process, so running several instances needs a shared adapter.
 *
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-001
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-002
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-003
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-004
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-005
 * @ears .sdd/features/test-drive-realtime/SPEC.md#REQ-006
 */

import { Server } from 'socket.io';
import { Roles } from '../constants/appConstants.js';
import User from '../models/User.js';
import { carSlotsQuerySchema } from '../routes/testDriveSchemas.js';
import { TokenType, isTokenCurrent, verifyTokenOfType } from '../utils/authTokens.js';
import logger from '../utils/logger.js';

export const STAFF_ROOM = 'staff';
export const customerRoom = (customerId) => `customer:${customerId}`;
export const slotsRoom = (date) => `slots:${date}`;

const MAX_FOLLOWED_DAYS = 5;

const STAFF_ROLES = new Set([Roles.SALES_STAFF, Roles.ADMIN]);

let io = null;

/** Same account checks as the API, reading the role from the account rather than the token. */
const authenticate = async (socket, next) => {
  const refuse = () => next(new Error('UNAUTHORIZED'));

  let decoded;
  try {
    decoded = verifyTokenOfType(socket.handshake.auth?.token, TokenType.ACCESS);
  } catch {
    return refuse();
  }

  try {
    const user = await User.findById(decoded.userId).select('+tokenVersion').lean();
    if (!user || !user.isActive || !isTokenCurrent(decoded, user)) return refuse();
    socket.data.user = { roleName: user.roleName, customer: user.customer };
    return next();
  } catch (error) {
    // The client only learns it was refused; the cause stays in the log.
    logger.error(`Realtime connection check failed: ${error.code || error.name}`);
    return refuse();
  }
};

const joinGroups = (socket) => {
  const { roleName, customer } = socket.data.user;
  if (STAFF_ROLES.has(roleName)) socket.join(STAFF_ROOM);
  if (roleName === Roles.CUSTOMER && customer) socket.join(customerRoom(customer));
};

/** The same dates the slots API accepts. */
const isValidDate = (date) => !carSlotsQuerySchema.validate({ date }).error;

const followedDays = (socket) => [...socket.rooms].filter((room) => room.startsWith('slots:'));

/**
 * Registers a day event and answers through the acknowledgement callback, if any.
 * The callback is always the last argument, so without a payload it comes first.
 */
const onDayEvent = (socket, event, handle) => socket.on(event, (...args) => {
  const date = args[0]?.date;
  const result = isValidDate(date) ? handle(date) : { ok: false, code: 'VALIDATION_ERROR' };
  const ack = args.at(-1);
  if (typeof ack === 'function') ack(result);
});

/** Lets a client follow the days it is looking at. A refused day keeps the connection. */
const handleDaySubscriptions = (socket) => {
  onDayEvent(socket, 'slots:subscribe', (date) => {
    const room = slotsRoom(date);
    if (!socket.rooms.has(room) && followedDays(socket).length >= MAX_FOLLOWED_DAYS) {
      return { ok: false, code: 'TOO_MANY_SUBSCRIPTIONS' };
    }
    socket.join(room);
    return { ok: true };
  });

  onDayEvent(socket, 'slots:unsubscribe', (date) => {
    socket.leave(slotsRoom(date));
    return { ok: true };
  });
};

/**
 * CORS does not apply to WebSocket connections, so the origin is checked here. A request
 * without an Origin header is not from a browser page; like the API, it relies on its token.
 */
const allowFrom = (origin) => (req, callback) => {
  const from = req.headers.origin;
  const allowed = origin === '*' || !from || [origin].flat().includes(from);
  callback(allowed ? null : 'ORIGIN_NOT_ALLOWED', allowed);
};

/**
 * @param {import('node:http').Server} httpServer
 * @param {{origin: string|string[]}} options - The same origins the API allows.
 */
export const startRealtime = (httpServer, { origin }) => {
  io = new Server(httpServer, {
    cors: { origin, methods: ['GET', 'POST'], credentials: true },
    allowRequest: allowFrom(origin),
  });
  io.use(authenticate);
  io.on('connection', (socket) => {
    joinGroups(socket);
    handleDaySubscriptions(socket);
  });
  return io;
};

/** @returns {import('socket.io').Server|null} null until started */
export const getRealtime = () => io;

/**
 * Closes every connection, including ones still authenticating, which the HTTP server's
 * close would wait for. Closing the transport rather than disconnecting the sockets makes
 * clients reconnect on their own after a restart. The caller owns the HTTP server.
 */
export const stopRealtime = () => {
  if (!io) return;
  io.engine.close();
  io = null;
};

export default { startRealtime, stopRealtime, getRealtime, STAFF_ROOM, customerRoom, slotsRoom };
