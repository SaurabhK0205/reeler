import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getClientIp, setResponseHeader } from './security.ts';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,128}$/;

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const SHORT_AUTH_TTL_MS = 2 * 60 * 1000;
const MAX_ACTIVE_ENTRIES = 500;
const MAX_COMPLETED_ENTRIES = 1000;
const MAX_IN_FLIGHT_SAFETY_MS = 5 * 60 * 1000;
const MAX_CACHED_BODY_BYTES = 256 * 1024;
const MAX_CANONICALIZE_DEPTH = 12;

interface InFlightEntry {
  state: 'in_progress';
  fingerprint: string;
  createdAt: number;
  safetyExpiresAt: number;
}

interface CompletedEntry {
  state: 'completed';
  fingerprint: string;
  statusCode: number;
  contentType: string;
  cacheControl: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyMiddlewareOptions {
  maxActiveEntries?: number;
  maxCompletedEntries?: number;
  defaultTtlMs?: number;
  shortAuthTtlMs?: number;
  inFlightSafetyMs?: number;
}

export interface ManagedIdempotencyMiddleware {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  clearForTesting: () => void;
  getCountsForTesting: () => { active: number; completed: number };
}

/**
 * Recursively canonicalizes JSON values with sorted object keys so semantically identical JSON
 * payloads hash to the same SHA-256 fingerprint regardless of property order.
 */
function canonicalizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_CANONICALIZE_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalizeValue(obj[key], depth + 1);
  }
  return sorted;
}

/**
 * Computes a SHA-256 request body fingerprint. Uses canonical key sorting for standard payloads
 * and fast direct serialization for large payloads (e.g., archive imports) to avoid extra cloning.
 */
export function computePayloadFingerprint(body: unknown, rawBody?: Buffer): string {
  const hash = crypto.createHash('sha256');
  if (Buffer.isBuffer(rawBody)) {
    hash.update(rawBody);
    return hash.digest('hex');
  }
  if (body === undefined || body === null) {
    hash.update('__empty__');
    return hash.digest('hex');
  }
  if (typeof body === 'string') {
    hash.update(body);
    return hash.digest('hex');
  }
  try {
    const rawJson = JSON.stringify(body);
    // For very large archive bodies (> 256 KB), hash directly without deep canonical re-allocation
    if (rawJson.length > 256 * 1024) {
      hash.update(rawJson);
      return hash.digest('hex');
    }
    hash.update(JSON.stringify(canonicalizeValue(body, 0)));
    return hash.digest('hex');
  } catch {
    hash.update(String(body));
    return hash.digest('hex');
  }
}

function getPrincipalScope(req: Request): string {
  if (req.vaultUser?.role === 'admin') {
    return 'admin';
  }
  if (req.vaultUser?.senderId) {
    return `user:${req.vaultUser.senderId}`;
  }
  return `anon:${getClientIp(req)}`;
}

/**
 * Creates a managed RFC-style Idempotency-Key middleware for mutating endpoints (POST, PUT, PATCH, DELETE):
 * - Separates active in-flight claims from evictable completed responses so pending operations can NEVER
 *   be evicted or expired out from under a running handler.
 * - Rejects new keyed work with 503 if active in-flight capacity is full instead of evicting an active lock.
 * - Keeps active claims locked even if the client socket disconnects mid-mutation so retries receive 409
 *   while the operation finishes, then replay the completed response once done.
 * - Enforces entry ownership before recording completions so an older completion can never overwrite a newer entry.
 */
export function createIdempotencyMiddleware(
  options: IdempotencyMiddlewareOptions = {}
): ManagedIdempotencyMiddleware {
  const maxActiveEntries = Math.max(1, options.maxActiveEntries ?? MAX_ACTIVE_ENTRIES);
  const maxCompletedEntries = Math.max(1, options.maxCompletedEntries ?? MAX_COMPLETED_ENTRIES);
  const defaultTtlMs = Math.max(1000, options.defaultTtlMs ?? DEFAULT_TTL_MS);
  const shortAuthTtlMs = Math.max(1000, options.shortAuthTtlMs ?? SHORT_AUTH_TTL_MS);
  const inFlightSafetyMs = Math.max(5000, options.inFlightSafetyMs ?? MAX_IN_FLIGHT_SAFETY_MS);

  const activeRequests = new Map<string, InFlightEntry>();
  const completedResponses = new Map<string, CompletedEntry>();

  const pruneCompleted = (now: number): void => {
    for (const [key, entry] of completedResponses.entries()) {
      if (entry.expiresAt <= now) {
        completedResponses.delete(key);
      }
    }
  };

  const pruneAbandonedActive = (now: number): void => {
    for (const [key, entry] of activeRequests.entries()) {
      if (entry.safetyExpiresAt <= now) {
        activeRequests.delete(key);
      }
    }
  };

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    pruneCompleted(now);
    pruneAbandonedActive(now);
  }, 60_000);
  cleanupInterval.unref();

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) {
      next();
      return;
    }

    // Meta webhook uses its own HMAC + message-ID deduplication contract
    const reqPath = req.path || '';
    if (reqPath.startsWith('/instagram/webhook')) {
      next();
      return;
    }

    const rawHeader = req.headers['idempotency-key'];
    if (rawHeader === undefined) {
      next();
      return;
    }

    if (Array.isArray(rawHeader)) {
      res.status(400).json({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Only a single Idempotency-Key header is permitted.',
      });
      return;
    }

    const idempotencyKey = String(rawHeader).trim();
    if (!VALID_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      res.status(400).json({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be 1 to 128 printable ASCII characters without spaces.',
      });
      return;
    }

    const now = Date.now();
    const normalizedPath = `${req.baseUrl || ''}${reqPath}`;
    const cacheKey = `${getPrincipalScope(req)}:${method}:${normalizedPath}:${idempotencyKey}`;
    const fingerprint = computePayloadFingerprint(req.body, (req as any).rawBody);

    // 1. Check active in-flight requests first (active operations are never evicted or expired early)
    const active = activeRequests.get(cacheKey);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        res.status(422).json({
          error: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'This Idempotency-Key was already used with a different request payload.',
        });
        return;
      }
      setResponseHeader(res, 'Retry-After', '2');
      res.status(409).json({
        error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is currently in progress. Please wait and retry.',
      });
      return;
    }

    // 2. Check completed responses for deterministic replay or payload conflict
    const completed = completedResponses.get(cacheKey);
    if (completed) {
      if (completed.expiresAt > now) {
        if (completed.fingerprint !== fingerprint) {
          res.status(422).json({
            error: 'IDEMPOTENCY_KEY_CONFLICT',
            message: 'This Idempotency-Key was already used with a different request payload.',
          });
          return;
        }
        setResponseHeader(res, 'Idempotency-Key', idempotencyKey);
        setResponseHeader(res, 'Idempotency-Replayed', 'true');
        setResponseHeader(res, 'Content-Type', completed.contentType);
        setResponseHeader(res, 'Cache-Control', completed.cacheControl);
        res.status(completed.statusCode).send(completed.body);
        return;
      }
      completedResponses.delete(cacheKey);
    }

    // 3. Enforce bounded active capacity without evicting any running operation
    if (activeRequests.size >= maxActiveEntries) {
      pruneAbandonedActive(now);
    }
    if (activeRequests.size >= maxActiveEntries) {
      setResponseHeader(res, 'Retry-After', '2');
      res.status(503).json({
        error: 'IDEMPOTENCY_CAPACITY_EXCEEDED',
        message: 'Too many concurrent mutating requests are currently in progress. Please retry shortly.',
      });
      return;
    }

    const ttlMs = reqPath.startsWith('/auth/otp') ? shortAuthTtlMs : defaultTtlMs;
    const inFlightEntry: InFlightEntry = {
      state: 'in_progress',
      fingerprint,
      createdAt: now,
      safetyExpiresAt: now + inFlightSafetyMs,
    };
    activeRequests.set(cacheKey, inFlightEntry);
    setResponseHeader(res, 'Idempotency-Key', idempotencyKey);

    let finalized = false;
    const finalizeWithPayload = (rawPayload: unknown, explicitContentType?: string) => {
      if (finalized) return;
      finalized = true;

      // Ownership check: only transition/update if this exact inFlightEntry still owns the slot
      if (activeRequests.get(cacheKey) !== inFlightEntry) {
        return;
      }
      activeRequests.delete(cacheKey);

      const statusCode = res.statusCode;
      // Never cache transient server errors or rate-limit rejections so clients can safely retry
      if (statusCode >= 500 || statusCode === 429) {
        return;
      }

      let serialized: string;
      let contentType = explicitContentType || String(res.getHeader('content-type') || 'application/json; charset=utf-8');
      if (typeof rawPayload === 'string') {
        serialized = rawPayload;
      } else if (Buffer.isBuffer(rawPayload)) {
        serialized = rawPayload.toString('utf8');
      } else if (rawPayload === undefined) {
        serialized = '';
      } else {
        serialized = JSON.stringify(rawPayload);
        if (!explicitContentType) {
          contentType = 'application/json; charset=utf-8';
        }
      }

      if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHED_BODY_BYTES) {
        return;
      }

      const completedAt = Date.now();
      if (completedResponses.size >= maxCompletedEntries) {
        pruneCompleted(completedAt);
      }
      while (completedResponses.size >= maxCompletedEntries) {
        const oldestKey = completedResponses.keys().next().value;
        if (oldestKey === undefined) break;
        completedResponses.delete(oldestKey);
      }

      const rawCacheControl = res.getHeader('cache-control');
      const cacheControl =
        typeof rawCacheControl === 'string' && rawCacheControl.trim()
          ? rawCacheControl.trim()
          : 'no-store';

      completedResponses.set(cacheKey, {
        state: 'completed',
        fingerprint,
        statusCode,
        contentType,
        cacheControl,
        body: serialized,
        createdAt: completedAt,
        expiresAt: completedAt + ttlMs,
      });
    };

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = ((body: any) => {
      finalizeWithPayload(body, 'application/json; charset=utf-8');
      return originalJson(body);
    }) as typeof res.json;

    res.send = ((body?: any) => {
      finalizeWithPayload(body);
      return originalSend(body);
    }) as typeof res.send;

    // Handle empty-body completions (e.g., 204 No Content via res.end())
    res.on('finish', () => {
      if (!finalized) {
        finalizeWithPayload('', String(res.getHeader('content-type') || 'text/plain; charset=utf-8'));
      }
    });

    // Intentionally do NOT remove inFlightEntry on socket 'close': an Express handler running an
    // async mutation may still commit after client disconnect. Keeping activeRequests locked ensures
    // retries get 409 while the mutation runs, then replay the finalized response once it finishes.

    next();
  };

  return {
    middleware,
    clearForTesting: () => {
      activeRequests.clear();
      completedResponses.clear();
    },
    getCountsForTesting: () => ({
      active: activeRequests.size,
      completed: completedResponses.size,
    }),
  };
}

const defaultIdempotency = createIdempotencyMiddleware();

/**
 * Default Express Idempotency-Key middleware mounted on the API router.
 */
export const idempotencyMiddleware = defaultIdempotency.middleware;

/**
 * Clears the default in-memory idempotency store (for testing only).
 */
export function clearIdempotencyStoreForTesting(): void {
  defaultIdempotency.clearForTesting();
}
