import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Constant-time UTF-8 string comparison safe against mismatched lengths and timing attacks.
 */
export function safeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Sets a response header safely on both real Express responses and lightweight unit-test mocks.
 */
export function setResponseHeader(res: Response, name: string, value: string): void {
  if (typeof (res as any).setHeader === 'function') {
    res.setHeader(name, value);
  } else if (typeof (res as any).set === 'function') {
    res.set(name, value);
  }
}

/**
 * Resolves the client IP address safely using Express's trust-proxy aware `req.ip`.
 * Normalizes IPv4-mapped IPv6 addresses (dotted-decimal `::ffff:a.b.c.d` or hexadecimal
 * `::ffff:HHHH:HHHH` -> `a.b.c.d`) so IP rotation and rate-limiting buckets do not bifurcate clients.
 */
export function getClientIp(req: Request): string {
  const raw = req.ip || req.socket?.remoteAddress || 'unknown';
  const ip = String(raw).trim();
  if (ip.toLowerCase().startsWith('::ffff:')) {
    const remainder = ip.slice(7).trim();
    if (remainder.includes('.')) {
      const octets = remainder.split('.');
      if (
        octets.length === 4 &&
        octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) >= 0 && Number(o) <= 255)
      ) {
        return octets.map(Number).join('.');
      }
    } else if (remainder.includes(':')) {
      const hexParts = remainder.split(':');
      if (
        hexParts.length === 2 &&
        hexParts.every((p) => /^[0-9a-fA-F]{1,4}$/.test(p))
      ) {
        const h1 = parseInt(hexParts[0], 16);
        const h2 = parseInt(hexParts[1], 16);
        return `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
      }
    }
  }
  return ip || 'unknown';
}

export interface RateLimiterOptions {
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Maximum permitted requests per key inside the window. */
  maxRequests: number;
  /** Hard upper bound on tracked keys to prevent memory exhaustion under IP rotation. */
  maxTrackedKeys?: number;
  /** Error code returned on 429 responses. */
  errorCode?: string;
  /** Human-readable error message returned on 429 responses. */
  message?: string;
  /** Custom key resolver (defaults to client IP). */
  keyGenerator?: (req: Request) => string;
  /** Optional predicate to bypass rate limiting for specific requests. */
  skip?: (req: Request) => boolean;
}

export interface ManagedRateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  resetForTesting: () => void;
  size: () => number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/**
 * Creates a bounded, eviction-safe in-memory rate limiter resistant to IP-rotation memory exhaustion.
 * When capacity is reached, expired buckets are pruned first, then the oldest bucket is evicted
 * instead of failing closed and locking out legitimate users.
 */
export function createRateLimiter(options: RateLimiterOptions): ManagedRateLimiter {
  const windowMs = Math.max(1000, options.windowMs);
  const maxRequests = Math.max(1, options.maxRequests);
  const maxTrackedKeys = Math.max(10, options.maxTrackedKeys ?? 5000);
  const errorCode = options.errorCode || 'RATE_LIMITED';
  const message = options.message || 'Too many requests. Please slow down and try again shortly.';
  const keyGenerator = options.keyGenerator || getClientIp;
  const skip = options.skip;

  const buckets = new Map<string, RateLimitBucket>();

  const pruneExpired = (now: number) => {
    for (const [k, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(k);
      }
    }
  };

  const cleanupInterval = setInterval(() => {
    pruneExpired(Date.now());
  }, Math.min(windowMs, 60_000));
  cleanupInterval.unref();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (skip?.(req)) {
      next();
      return;
    }

    const now = Date.now();
    const key = keyGenerator(req);
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (bucket) {
        buckets.delete(key);
      }
      if (buckets.size >= maxTrackedKeys) {
        pruneExpired(now);
      }
      if (buckets.size >= maxTrackedKeys) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) {
          buckets.delete(oldestKey);
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, maxRequests - bucket.count);
    const resetSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    setResponseHeader(res, 'RateLimit-Limit', String(maxRequests));
    setResponseHeader(res, 'RateLimit-Remaining', String(remaining));
    setResponseHeader(res, 'RateLimit-Reset', String(resetSec));

    if (bucket.count > maxRequests) {
      setResponseHeader(res, 'Retry-After', String(resetSec));
      res.status(429).json({
        error: errorCode,
        message,
        retryAfterSeconds: resetSec,
      });
      return;
    }

    next();
  };

  return {
    middleware,
    resetForTesting: () => buckets.clear(),
    size: () => buckets.size,
  };
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "frame-src https://www.instagram.com https://instagram.com",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Sets defense-in-depth HTTP security headers across all application and API responses.
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  setResponseHeader(res, 'X-Content-Type-Options', 'nosniff');
  setResponseHeader(res, 'X-Frame-Options', 'DENY');
  setResponseHeader(res, 'Referrer-Policy', 'strict-origin-when-cross-origin');
  setResponseHeader(res, 'Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  setResponseHeader(res, 'X-DNS-Prefetch-Control', 'off');
  setResponseHeader(res, 'Cross-Origin-Opener-Policy', 'same-origin');
  setResponseHeader(res, 'Cross-Origin-Resource-Policy', 'same-origin');
  setResponseHeader(res, 'Content-Security-Policy', CONTENT_SECURITY_POLICY);

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (req.secure || forwardedProto === 'https') {
    setResponseHeader(res, 'Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}
