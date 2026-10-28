/**
 * @file authTokens.js
 * @description JWT helpers shared by authService and authMiddleware.
 *
 * Every token carries:
 * - `type`: 'access' | 'refresh' – a token is only accepted where its type is expected.
 * - `tv`:   the user's tokenVersion at issue time. Logout / password change /
 *           password reset bump User.tokenVersion, so every older token on every
 *           device stops matching and is rejected on the next request.
 *
 * Tokens without `type` or `tv` (issued before this scheme) are rejected.
 *
 * Ref: GBR-01 (token lifetimes), GBR-21 (active session enforcement)
 */

import jwt from 'jsonwebtoken';

export const TokenType = Object.freeze({
  ACCESS:  'access',
  REFRESH: 'refresh',
});

const ISSUER   = 'TrustCar';
const AUDIENCE = 'TrustCar-Client';

/**
 * Builds the access-token payload from a User document.
 * @param {object} user - Must include tokenVersion (select '+tokenVersion').
 */
export const signAccessToken = (user) =>
  jwt.sign(
    {
      userId:   user._id.toString(),
      email:    user.email,
      roleName: user.roleName,
      type:     TokenType.ACCESS,
      tv:       user.tokenVersion ?? 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m', issuer: ISSUER, audience: AUDIENCE }
  );

/**
 * Builds the refresh-token payload from a User document.
 * @param {object} user - Must include tokenVersion (select '+tokenVersion').
 */
export const signRefreshToken = (user) =>
  jwt.sign(
    {
      userId: user._id.toString(),
      type:   TokenType.REFRESH,
      tv:     user.tokenVersion ?? 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', issuer: ISSUER, audience: AUDIENCE }
  );

/**
 * Verifies signature, expiry, issuer, audience and token type.
 * Throws the original jsonwebtoken error (TokenExpiredError / JsonWebTokenError),
 * or a JsonWebTokenError when the type or version claim is missing/wrong.
 *
 * @param {string} token
 * @param {'access'|'refresh'} expectedType
 * @returns {object} Decoded payload.
 */
export const verifyTokenOfType = (token, expectedType) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
  if (decoded.type !== expectedType || !Number.isInteger(decoded.tv)) {
    throw new jwt.JsonWebTokenError('invalid token type');
  }
  return decoded;
};

/**
 * True when the token was issued for the user's current tokenVersion,
 * i.e. no logout / password change / reset happened after it was issued.
 * @param {object} decoded - Payload from verifyTokenOfType.
 * @param {object} user    - Must include tokenVersion (select '+tokenVersion').
 */
export const isTokenCurrent = (decoded, user) => decoded.tv === (user.tokenVersion ?? 0);

export default { TokenType, signAccessToken, signRefreshToken, verifyTokenOfType, isTokenCurrent };
