'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'smarterp-ai';
const AUDIENCE = 'smarterp-ai-action';
const TOKEN_TTL_SECONDS = 300;

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createApprovalToken({ userId, companyId, action, payload }, secret = process.env.JWT_SECRET) {
  if (!secret || !userId || !companyId || !action || !payload) {
    const error = new Error('AI action approvals are not configured.');
    error.code = 'AI_APPROVAL_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  return jwt.sign({
    sub: String(userId),
    companyId: String(companyId),
    action: String(action),
    payloadHash: stableHash(payload),
    jti: crypto.randomUUID(),
  }, secret, { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS, issuer: ISSUER, audience: AUDIENCE });
}

async function consumeApprovalToken(token, { userId, companyId, action, payload, redisClient, secret = process.env.JWT_SECRET }) {
  let claims;
  try {
    claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
  } catch (_) {
    const error = new Error('The AI action approval is invalid or expired. Request a new approval.');
    error.code = 'AI_APPROVAL_INVALID';
    error.statusCode = 403;
    throw error;
  }

  if (claims.sub !== String(userId) || claims.companyId !== String(companyId)
      || claims.action !== String(action) || claims.payloadHash !== stableHash(payload)
      || !claims.jti) {
    const error = new Error('The approval does not match this user, company, action, or payload.');
    error.code = 'AI_APPROVAL_SCOPE_MISMATCH';
    error.statusCode = 403;
    throw error;
  }
  if (!redisClient) {
    const error = new Error('Single-use AI action approvals require the approval store.');
    error.code = 'AI_APPROVAL_STORE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  let consumed;
  try {
    consumed = await redisClient.set(`ai_action_approval:${claims.jti}`, '1', 'NX', 'EX', TOKEN_TTL_SECONDS);
  } catch (_) {
    const error = new Error('AI action approval could not be verified. Please retry.');
    error.code = 'AI_APPROVAL_STORE_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  if (consumed !== 'OK') {
    const error = new Error('This AI action approval has already been used. Request a new approval.');
    error.code = 'AI_APPROVAL_ALREADY_USED';
    error.statusCode = 409;
    throw error;
  }
  return true;
}

module.exports = { createApprovalToken, consumeApprovalToken, stableHash, TOKEN_TTL_SECONDS };
