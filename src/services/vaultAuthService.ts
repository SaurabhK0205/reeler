import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config.ts';

export interface VaultUserSession {
  role: 'admin' | 'user';
  senderId?: string;
}

interface PendingOtp {
  code: string;
  role: 'admin' | 'user';
  senderId?: string;
  createdAt: number;
  expiresAt: number;
}

const pendingOtps = new Map<string, PendingOtp>();

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
    }
  }
}

/**
 * Generates a cryptographically random 6-digit numeric login OTP bound to the given user session.
 */
export function createOtp(session: VaultUserSession, ttlMs: number = OTP_DEFAULT_TTL_MS): string {
  cleanupExpiredOtps();

  // Generate 6-digit numeric string (100000 - 999999)
  const code = String(crypto.randomInt(100000, 1000000));
  const now = Date.now();

  pendingOtps.set(code, {
    code,
    role: session.role,
    senderId: session.senderId,
    createdAt: now,
    expiresAt: now + ttlMs,
  });

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
    return { valid: false };
  }

  // Immediately delete upon consumption (one-time use)
  pendingOtps.delete(normalizedCode);

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
 * Clears in-memory OTPs (for testing only).
 */
export function clearOtpsForTesting(): void {
  pendingOtps.clear();
}

declare global {
  namespace Express {
    interface Request {
      vaultUser?: VaultUserSession;
    }
  }
}

/**
 * Resolves the server secret used to sign and verify zero-login vault tokens.
 */
export function getVaultSecret(): string {
  const config = loadConfig();
  const configuredSecret = process.env.VAULT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (configuredSecret && configuredSecret.trim()) {
    return configuredSecret.trim();
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
 * Generates a URL-safe, tamper-proof vault access key for a specific Instagram sender ID.
 */
export function generateUserVaultKey(senderId: string): string {
  const trimmed = String(senderId || '').trim();
  if (!trimmed) {
    throw new Error('Cannot generate vault key for empty senderId');
  }
  const secret = getVaultSecret();
  const signature = crypto.createHmac('sha256', secret).update(`user:${trimmed}`).digest('hex').slice(0, 24);
  return Buffer.from(`user.${trimmed}.${signature}`).toString('base64url');
}

/**
 * Verifies an incoming vault key and unpacks the role and Instagram sender ID.
 */
export function verifyVaultKey(key: string): { valid: boolean; session?: VaultUserSession } {
  if (!key || typeof key !== 'string') {
    return { valid: false };
  }
  const trimmedKey = key.trim();

  // 1. Check against Admin Key
  const adminKey = getAdminVaultKey();
  if (trimmedKey === adminKey) {
    return {
      valid: true,
      session: { role: 'admin' },
    };
  }

  // 2. Decode user token
  try {
    const raw = Buffer.from(trimmedKey, 'base64url').toString('utf-8');
    const parts = raw.split('.');
    if (parts.length === 3 && parts[0] === 'admin') {
      const [, adminId, signature] = parts;
      const secret = getVaultSecret();
      const expectedSig = crypto.createHmac('sha256', secret).update(`admin:${adminId}`).digest('hex').slice(0, 24);
      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        return {
          valid: true,
          session: { role: 'admin' },
        };
      }
      return { valid: false };
    }

    if (parts.length === 3 && parts[0] === 'user') {
      const [, senderId, signature] = parts;
      if (!senderId) return { valid: false };
      const secret = getVaultSecret();
      const expectedSig = crypto.createHmac('sha256', secret).update(`user:${senderId}`).digest('hex').slice(0, 24);
      if (signature.length === expectedSig.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
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
  // Public bypass paths: Meta webhook, health check, image dimension probe, and OTP verification
  const path = req.path || '';
  if (
    path === '/health' ||
    path.startsWith('/instagram/webhook') ||
    path.includes('/meta') ||
    path.startsWith('/auth/otp')
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

  // If running locally in development without a key, permit admin fallback for zero-friction local testing
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    req.vaultUser = { role: 'admin' };
    return next();
  }

  res.status(401).json({
    error: 'UNAUTHORIZED',
    code: 'VAULT_KEY_REQUIRED',
    message: 'To access your private vault, send a reel or message "vault" to our Instagram bot to receive your access key.',
  });
}
