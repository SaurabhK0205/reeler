import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config.ts';
import { createRateLimiter, getClientIp, safeStringEqual, setResponseHeader } from '../middleware/security.ts';

export interface VaultUserSession {
  role: 'admin' | 'user';
  senderId?: string;
}

interface PendingOtp {
  code: string;
  principalKey: string;
  role: 'admin' | 'user';
  senderId?: string;
  createdAt: number;
  expiresAt: number;
}

export class OtpCapacityError extends Error {
  public readonly code = 'OTP_CAPACITY_REACHED';
  constructor() {
    super('Too many active login codes across users. Please wait a moment and try again.');
    this.name = 'OtpCapacityError';
  }
}

const pendingOtps = new Map<string, PendingOtp>();
const principalToOtp = new Map<string, string>();
const MAX_PENDING_OTPS = 500;
const REEL_META_PATH_RE = /^\/reels\/[^/]+\/meta$/;

function resolveOtpPrincipalKey(session: VaultUserSession): string {
  if (session.role === 'admin') {
    return 'admin';
  }
  const sender = String(session.senderId || '').trim();
  if (!sender) {
    throw new Error('Cannot generate user OTP without senderId');
  }
  return `user:${sender}`;
}

/**
 * Default OTP Time-To-Live: 10 minutes.
 */
export const OTP_DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Removes expired OTPs from the in-memory store.
 */
function cleanupExpiredOtps(): void {
  const now = Date.now();
  for (const [code, item] of pendingOtps.entries()) {
    if (item.expiresAt <= now) {
      pendingOtps.delete(code);
      if (principalToOtp.get(item.principalKey) === code) {
        principalToOtp.delete(item.principalKey);
      }
    }
  }
}

/**
 * Generates a cryptographically random 6-digit numeric login OTP bound to the given user session.
 * Enforces one active OTP per principal (replacing the caller's own prior code) and never evicts
 * another principal's unexpired login code (CWE-400 mitigation).
 */
export function createOtp(session: VaultUserSession, ttlMs: number = OTP_DEFAULT_TTL_MS): string {
  cleanupExpiredOtps();

  const principalKey = resolveOtpPrincipalKey(session);
  const existingCode = principalToOtp.get(principalKey);
  if (existingCode) {
    pendingOtps.delete(existingCode);
    principalToOtp.delete(principalKey);
  }

  if (pendingOtps.size >= MAX_PENDING_OTPS) {
    throw new OtpCapacityError();
  }

  let code: string;
  let attempts = 0;
  do {
    code = String(crypto.randomInt(100000, 1000000));
    attempts++;
    if (attempts > 100) {
      throw new Error('Failed to generate unique OTP code due to high concurrency');
    }
  } while (pendingOtps.has(code));

  const now = Date.now();
  pendingOtps.set(code, {
    code,
    principalKey,
    role: session.role,
    senderId: session.senderId,
    createdAt: now,
    expiresAt: now + ttlMs,
  });
  principalToOtp.set(principalKey, code);

  return code;
}

/**
 * Verifies and consumes a 6-digit login OTP, returning the session and full vault key.
 * One-time use: invalidates the OTP immediately upon successful verification.
 */
export function verifyOtp(code: string): { valid: boolean; session?: VaultUserSession; vaultKey?: string } {
  cleanupExpiredOtps();

  if (!code || typeof code !== 'string') {
    return { valid: false };
  }

  const normalizedCode = code.trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalizedCode)) {
    return { valid: false };
  }

  const record = pendingOtps.get(normalizedCode);
  if (!record) {
    return { valid: false };
  }

  if (record.expiresAt <= Date.now()) {
    pendingOtps.delete(normalizedCode);
    if (principalToOtp.get(record.principalKey) === normalizedCode) {
      principalToOtp.delete(record.principalKey);
    }
    return { valid: false };
  }

  // Immediately delete upon consumption (one-time use)
  pendingOtps.delete(normalizedCode);
  if (principalToOtp.get(record.principalKey) === normalizedCode) {
    principalToOtp.delete(record.principalKey);
  }

  const session: VaultUserSession = {
    role: record.role,
    ...(record.senderId ? { senderId: record.senderId } : {}),
  };

  const vaultKey = session.role === 'admin'
    ? getAdminVaultKey()
    : generateUserVaultKey(session.senderId!);

  return {
    valid: true,
    session,
    vaultKey,
  };
}

/**
 * Checks whether the given 6-digit OTP is currently active and unexpired without consuming it.
 */
export function isOtpActive(code: string): boolean {
  cleanupExpiredOtps();
  const record = pendingOtps.get(code);
  return Boolean(record && record.expiresAt > Date.now());
}

/**
 * Clears in-memory OTPs (for testing only).
 */
export function clearOtpsForTesting(): void {
  pendingOtps.clear();
  principalToOtp.clear();
}

const MAX_OTP_VERIFY_ATTEMPTS = 5;
const OTP_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const MAX_TRACKED_OTP_IPS = 2000;
const otpIpAttempts = new Map<string, { count: number; resetAt: number }>();

function pruneExpiredOtpAttempts(now: number): void {
  for (const [ip, record] of otpIpAttempts.entries()) {
    if (record.resetAt <= now) {
      otpIpAttempts.delete(ip);
    }
  }
}

const otpAttemptCleanupInterval = setInterval(() => {
  pruneExpiredOtpAttempts(Date.now());
}, 60_000);
otpAttemptCleanupInterval.unref();

const otpRequestLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  maxRequests: 5,
  maxTrackedKeys: 2000,
  errorCode: 'TOO_MANY_OTP_REQUESTS',
  message: 'Too many login code requests. Please wait before requesting another code.',
});

/**
 * Express middleware protecting /api/auth/otp/request against DM spam and OTP flooding.
 */
export const otpRequestRateLimiter = otpRequestLimiter.middleware;

/**
 * Express middleware protecting /api/auth/otp/verify with per-client-IP rate limiting (CWE-307 mitigation).
 * Evicts expired entries first, then oldest entry if at capacity, preventing IP-rotation lockout DoS.
 */
export function otpVerifyRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const now = Date.now();

  const record = otpIpAttempts.get(ip);
  if (record && record.resetAt > now) {
    if (record.count >= MAX_OTP_VERIFY_ATTEMPTS) {
      const retryAfterSec = Math.ceil((record.resetAt - now) / 1000);
      setResponseHeader(res, 'Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'TOO_MANY_ATTEMPTS',
        message: `Too many failed verification attempts. Please wait ${retryAfterSec} seconds before trying again.`,
      });
      return;
    }
  } else {
    if (record) {
      otpIpAttempts.delete(ip);
    }
    if (otpIpAttempts.size >= MAX_TRACKED_OTP_IPS) {
      pruneExpiredOtpAttempts(now);
    }
    if (otpIpAttempts.size >= MAX_TRACKED_OTP_IPS) {
      const oldestIp = otpIpAttempts.keys().next().value;
      if (oldestIp !== undefined) {
        otpIpAttempts.delete(oldestIp);
      }
    }
    otpIpAttempts.set(ip, { count: 0, resetAt: now + OTP_RATE_LIMIT_WINDOW_MS });
  }

  next();
}

/**
 * Records a failed verification attempt against the client IP.
 */
export function recordOtpFailure(ip: string): void {
  const now = Date.now();
  const record = otpIpAttempts.get(ip);
  if (record && record.resetAt > now) {
    record.count++;
  } else {
    if (otpIpAttempts.size >= MAX_TRACKED_OTP_IPS) {
      pruneExpiredOtpAttempts(now);
    }
    otpIpAttempts.set(ip, { count: 1, resetAt: now + OTP_RATE_LIMIT_WINDOW_MS });
  }
}

/**
 * Resets failed attempt counter upon successful OTP verification.
 */
export function resetOtpAttempts(ip: string): void {
  otpIpAttempts.delete(ip);
}

/**
 * Clears rate limiter tracking (for testing only).
 */
export function clearOtpRateLimitsForTesting(): void {
  otpIpAttempts.clear();
  otpRequestLimiter.resetForTesting();
}

export interface RequestOtpResult {
  success: boolean;
  code?: string;
  message: string;
}

/**
 * Encapsulates OTP dispatch policy: checks whether the requested username is the admin,
 * dispatches via Instagram DM, and validates actual delivery.
 */
export async function requestOtpForUsername(
  usernameInput: string,
  sendDm: (recipientId: string, message: string) => Promise<boolean>,
  adminSenderId?: string | null
): Promise<RequestOtpResult> {
  const username = usernameInput.trim().replace(/^@/, '').toLowerCase();
  const config = loadConfig();
  const adminUser = (config.instagram.adminUsername || process.env.ADMIN_USERNAME || 'admin').toLowerCase().replace(/^@/, '');
  const targetSenderId = adminSenderId || config.instagram.userId;

  if (username && username === adminUser && targetSenderId) {
    cleanupExpiredOtps();
    const previousCode = principalToOtp.get('admin');
    const previousRecord = previousCode ? pendingOtps.get(previousCode) : undefined;
    const preservedPrevious =
      previousRecord && previousRecord.expiresAt > Date.now() ? { ...previousRecord } : null;

    let code: string;
    try {
      code = createOtp({ role: 'admin' });
    } catch (error) {
      if (error instanceof OtpCapacityError) {
        return {
          success: false,
          code: error.code,
          message: error.message,
        };
      }
      throw error;
    }

    const rollbackUndeliveredOtp = () => {
      if (principalToOtp.get('admin') !== code) {
        return;
      }
      pendingOtps.delete(code);
      principalToOtp.delete('admin');
      if (preservedPrevious && preservedPrevious.expiresAt > Date.now()) {
        pendingOtps.set(preservedPrevious.code, preservedPrevious);
        principalToOtp.set('admin', preservedPrevious.code);
      }
    };

    const message =
      `🔐 Your Reeler Login Code:\n${code}\n\n` +
      `Enter this 6-digit code on your PC or laptop browser to unlock your private vault (valid for 10 minutes).`;
    let delivered: boolean;
    try {
      delivered = await sendDm(targetSenderId, message);
    } catch (error) {
      rollbackUndeliveredOtp();
      throw error;
    }
    if (!delivered) {
      rollbackUndeliveredOtp();
      return {
        success: false,
        code: 'DELIVERY_FAILED',
        message: 'Failed to deliver login code to Instagram DM. Please check messaging permissions.',
      };
    }
    return {
      success: true,
      message: 'Login code dispatched to your Instagram DM.',
    };
  }

  return {
    success: false,
    code: 'DM_THE_BOT_DIRECTLY',
    message: 'To receive a 6-digit login code, simply message "code" or "login" to our bot on Instagram.',
  };
}

declare global {
  namespace Express {
    interface Request {
      vaultUser?: VaultUserSession;
    }
  }
}

/**
 * Resolves the configured non-blank vault signing secret using canonical precedence
 * (`VAULT_SECRET`, then `SUPABASE_SERVICE_ROLE_KEY`). Returns null if neither is set.
 */
export function resolveConfiguredVaultSecret(): string | null {
  const vaultSecret = process.env.VAULT_SECRET?.trim();
  if (vaultSecret) {
    return vaultSecret;
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceRoleKey) {
    return serviceRoleKey;
  }
  return null;
}

/**
 * Detects whether the current process is running in a hosted, production, or staged environment
 * where unauthenticated access bypasses and default insecure secrets MUST be strictly forbidden.
 */
export function isHostedOrProductionEnvironment(): boolean {
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  const appEnv = (process.env.APP_ENV || '').trim().toLowerCase();

  if (nodeEnv === 'production' || nodeEnv === 'staging' || appEnv === 'production' || appEnv === 'staging') {
    return true;
  }

  return Boolean(
    process.env.RENDER ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.FLY_APP_NAME ||
    process.env.HEROKU_APP_ID ||
    process.env.DYNO ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.VERCEL ||
    process.env.AWS_EXECUTION_ENV ||
    process.env.ECS_CONTAINER_METADATA_URI ||
    process.env.KUBERNETES_SERVICE_HOST
  );
}

/**
 * Resolves the server secret used to sign and verify zero-login vault tokens.
 * Fails closed in production and hosted environments if neither VAULT_SECRET nor SUPABASE_SERVICE_ROLE_KEY is configured.
 */
export function getVaultSecret(): string {
  const configuredSecret = resolveConfiguredVaultSecret();
  if (configuredSecret) {
    return configuredSecret;
  }
  if (isHostedOrProductionEnvironment()) {
    throw new Error(
      'Production and hosted environments require a non-blank VAULT_SECRET or SUPABASE_SERVICE_ROLE_KEY to sign vault tokens.'
    );
  }
  return 'reeler-default-vault-secret-do-not-use-in-production';
}

/**
 * Derives a deterministic, tamper-proof admin vault key.
 */
export function getAdminVaultKey(): string {
  const explicitKey = process.env.ADMIN_VAULT_KEY?.trim();
  if (explicitKey) {
    return explicitKey;
  }
  const config = loadConfig();
  const adminIdentifier = config.instagram.adminUsername || config.instagram.userId || 'admin';
  const secret = getVaultSecret();
  const signature = crypto.createHmac('sha256', secret).update(`admin:${adminIdentifier}`).digest('hex').slice(0, 24);
  return Buffer.from(`admin.${adminIdentifier}.${signature}`).toString('base64url');
}

/**
 * Maximum server-side lifetime for a timestamped user vault token (14 days hard ceiling).
 */
export const MAX_USER_TOKEN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const revokedSenderTimestamps = new Map<string, number>();

/**
 * Revokes all existing vault tokens for a sender (e.g. upon user data deletion).
 */
export function revokeTokensForSender(senderId: string): void {
  const trimmed = String(senderId || '').trim();
  if (trimmed) {
    revokedSenderTimestamps.set(trimmed, Date.now());
  }
}

/**
 * Checks whether tokens for a given sender have been revoked.
 * Non-timestamped tokens are revoked if any revocation exists.
 * Timestamped tokens are revoked if issued before or at the revocation timestamp.
 */
export function isTokenRevokedForSender(senderId: string, issuedAt?: number): boolean {
  const trimmed = String(senderId || '').trim();
  if (!trimmed) return false;
  const revokedAt = revokedSenderTimestamps.get(trimmed);
  if (!revokedAt) return false;
  if (!issuedAt || !Number.isFinite(issuedAt)) {
    return true;
  }
  return issuedAt <= revokedAt;
}

/**
 * Resets token revocation state (for testing only).
 */
export function clearTokenRevocationsForTesting(): void {
  revokedSenderTimestamps.clear();
}

/**
 * Generates a URL-safe, tamper-proof vault access key for a specific Instagram sender ID.
 * When `issuedAt` is provided, binds the issuance epoch to enforce maximum token age.
 */
export function generateUserVaultKey(senderId: string, issuedAt?: number): string {
  const trimmed = String(senderId || '').trim();
  if (!trimmed) {
    throw new Error('Cannot generate vault key for empty senderId');
  }
  const secret = getVaultSecret();
  if (typeof issuedAt === 'number' && Number.isFinite(issuedAt) && issuedAt > 0) {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`user:${trimmed}:${issuedAt}`)
      .digest('hex')
      .slice(0, 24);
    return Buffer.from(`user.${trimmed}.${issuedAt}.${signature}`).toString('base64url');
  }
  const signature = crypto.createHmac('sha256', secret).update(`user:${trimmed}`).digest('hex').slice(0, 24);
  return Buffer.from(`user.${trimmed}.${signature}`).toString('base64url');
}

/**
 * Verifies an incoming vault key and unpacks the role and Instagram sender ID.
 * Enforces signature validity and expiration for timestamped tokens.
 */
export function verifyVaultKey(key: string): { valid: boolean; session?: VaultUserSession } {
  if (!key || typeof key !== 'string') {
    return { valid: false };
  }
  const trimmedKey = key.trim();

  // 1. Check against Admin Key using constant-time comparison
  const adminKey = getAdminVaultKey();
  if (safeStringEqual(trimmedKey, adminKey)) {
    return {
      valid: true,
      session: { role: 'admin' },
    };
  }

  // 2. Decode user or admin token
  try {
    const raw = Buffer.from(trimmedKey, 'base64url').toString('utf-8');
    const parts = raw.split('.');
    if (parts.length === 3 && parts[0] === 'admin') {
      const [, adminId, signature] = parts;
      if (!adminId) return { valid: false };
      const secret = getVaultSecret();
      const expectedSig = crypto.createHmac('sha256', secret).update(`admin:${adminId}`).digest('hex').slice(0, 24);
      if (safeStringEqual(signature, expectedSig)) {
        return {
          valid: true,
          session: { role: 'admin' },
        };
      }
      return { valid: false };
    }

    // 2b. Timestamped user token: user.<senderId>.<issuedAt>.<signature>
    if (parts.length === 4 && parts[0] === 'user') {
      const [, senderId, rawIssuedAt, signature] = parts;
      const issuedAt = Number(rawIssuedAt);
      if (!senderId || !Number.isFinite(issuedAt) || issuedAt <= 0) return { valid: false };
      const now = Date.now();
      // Reject tokens issued in the future (allowing 60s clock skew) or older than MAX_USER_TOKEN_AGE_MS
      if (issuedAt > now + 60_000 || now - issuedAt > MAX_USER_TOKEN_AGE_MS) {
        return { valid: false };
      }
      if (isTokenRevokedForSender(senderId, issuedAt)) {
        return { valid: false };
      }
      const secret = getVaultSecret();
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`user:${senderId}:${rawIssuedAt}`)
        .digest('hex')
        .slice(0, 24);
      if (safeStringEqual(signature, expectedSig)) {
        return {
          valid: true,
          session: { role: 'user', senderId },
        };
      }
      return { valid: false };
    }

    // 2c. Legacy non-timestamped user token: user.<senderId>.<signature>
    if (parts.length === 3 && parts[0] === 'user') {
      if (process.env.ALLOW_LEGACY_VAULT_TOKENS === 'false' || process.env.REQUIRE_TIMESTAMPED_VAULT_TOKENS === 'true') {
        return { valid: false };
      }
      const [, senderId, signature] = parts;
      if (!senderId) return { valid: false };
      if (isTokenRevokedForSender(senderId)) {
        return { valid: false };
      }
      const secret = getVaultSecret();
      const expectedSig = crypto.createHmac('sha256', secret).update(`user:${senderId}`).digest('hex').slice(0, 24);
      if (safeStringEqual(signature, expectedSig)) {
        return {
          valid: true,
          session: { role: 'user', senderId },
        };
      }
    }
  } catch {
    return { valid: false };
  }

  return { valid: false };
}

/**
 * Express middleware protecting /api endpoints with zero-login vault token verification.
 * Automatically permits local development fallback when running outside production.
 */
export function vaultAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Public bypass paths: Meta webhook, health check, reel metadata probe, and OTP endpoints
  const reqPath = req.path || '';
  const normalizedOtpPath = reqPath.length > 1 && reqPath.endsWith('/') ? reqPath.slice(0, -1) : reqPath;
  if (
    reqPath === '/health' ||
    reqPath === '/instagram/webhook' ||
    reqPath.startsWith('/instagram/webhook/') ||
    REEL_META_PATH_RE.test(reqPath) ||
    normalizedOtpPath === '/auth/otp/verify' ||
    normalizedOtpPath === '/auth/otp/request'
  ) {
    return next();
  }

  const rawKey = req.headers['x-vault-key'] || req.headers['x-access-key'] || req.query.key;
  const keyString = typeof rawKey === 'string' ? rawKey.trim() : Array.isArray(rawKey) ? String(rawKey[0] || '').trim() : '';

  if (keyString) {
    const verification = verifyVaultKey(keyString);
    if (verification.valid && verification.session) {
      req.vaultUser = verification.session;
      return next();
    }
    res.status(401).json({
      error: 'UNAUTHORIZED',
      code: 'INVALID_VAULT_KEY',
      message: 'The provided vault access key is invalid or has expired.',
    });
    return;
  }

  // In hosted, staged, or production environments, missing or invalid keys MUST always return 401
  const isStrictEnv = isHostedOrProductionEnvironment();
  if (isStrictEnv) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      code: 'VAULT_KEY_REQUIRED',
      message: 'To access your private vault, send a reel or message "vault" to our Instagram bot to receive your access key.',
    });
    return;
  }

  // If running locally in development without a key, permit admin fallback for zero-friction local testing
  req.vaultUser = { role: 'admin' };
  return next();
}

/**
 * Express middleware enforcing authenticated admin access before expensive parsers or guards run.
 */
export function requireAdminVaultMiddleware(req: Request, res: Response, next: NextFunction): void {
  vaultAuthMiddleware(req, res, () => {
    if (req.vaultUser?.role !== 'admin') {
      res.status(403).json({
        success: false,
        error: 'Only the vault administrator can perform this action.',
      });
      return;
    }
    next();
  });
}
