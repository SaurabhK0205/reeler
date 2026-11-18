import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getClientIp } from './security.ts';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,128}$/;

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const SHORT_AUTH_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 1000;
const MAX_CACHED_BODY_BYTES = 256 * 1024;
const MAX_CANONICALIZE_DEPTH = 12;

interface InFlightEntry {
  state: 'in_progress';
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
}

interface CompletedEntry {
  state: 'completed';
  fingerprint: string;
  statusCode: number;
  contentType: string;
  body: string;
  createdAt: number;
  expiresAt: number;
}

type IdempotencyEntry = InFlightEntry | CompletedEntry;

const idempotencyStore = new Map<string, IdempotencyEntry>();

function pruneExpiredEntries(now: number): void {
  for (const [key, entry] of idempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      idempotencyStore.delete(key);
    }
  }
}

const cleanupInterval = setInterval(() => {
  pruneExpiredEntries(Date.now());
}, 60_000);
cleanupInterval.unref();

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
 * Express middleware enforcing RFC-style Idempotency-Key semantics on mutating endpoints
 * (POST, PUT, PATCH, DELETE):
 * - Scoped by authenticated principal (or client IP), HTTP method, normalized route path, and key.
 * - Rejects malformed keys (400), conflicting payloads on key reuse (422), and concurrent in-flight duplicates (409).
 * - Replays deterministic completed responses (2xx and deterministic 4xx except 429) with `Idempotency-Replayed: true`.
 * - Never caches 5xx, 429, or aborted requests so callers can safely retry transient failures.
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
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

  const existing = idempotencyStore.get(cacheKey);
  if (existing && existing.expiresAt > now) {
    if (existing.fingerprint !== fingerprint) {
      res.status(422).json({
        error: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'This Idempotency-Key was already used with a different request payload.',
      });
      return;
    }

    if (existing.state === 'in_progress') {
      res.setHeader('Retry-After', '2');
      res.status(409).json({
        error: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is currently in progress. Please wait and retry.',
      });
      return;
    }

    res.setHeader('Idempotency-Key', idempotencyKey);
    res.setHeader('Idempotency-Replayed', 'true');
    res.setHeader('Content-Type', existing.contentType);
    res.status(existing.statusCode).send(existing.body);
    return;
  }

  if (existing) {
    idempotencyStore.delete(cacheKey);
  }

  if (idempotencyStore.size >= MAX_ENTRIES) {
    pruneExpiredEntries(now);
  }
  if (idempotencyStore.size >= MAX_ENTRIES) {
    const oldestKey = idempotencyStore.keys().next().value;
    if (oldestKey !== undefined) {
      idempotencyStore.delete(oldestKey);
    }
  }

  const ttlMs = reqPath.startsWith('/auth/otp') ? SHORT_AUTH_TTL_MS : DEFAULT_TTL_MS;
  const inFlightEntry: InFlightEntry = {
    state: 'in_progress',
    fingerprint,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  idempotencyStore.set(cacheKey, inFlightEntry);

  res.setHeader('Idempotency-Key', idempotencyKey);

  let finalized = false;
  const finalizeWithPayload = (rawPayload: unknown, explicitContentType?: string) => {
    if (finalized) return;
    finalized = true;

    const statusCode = res.statusCode;
    // Never cache transient server errors or rate-limit rejections so clients can safely retry
    if (statusCode >= 500 || statusCode === 429) {
      if (idempotencyStore.get(cacheKey) === inFlightEntry) {
        idempotencyStore.delete(cacheKey);
      }
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
      if (idempotencyStore.get(cacheKey) === inFlightEntry) {
        idempotencyStore.delete(cacheKey);
      }
      return;
    }

    const completedAt = Date.now();
    idempotencyStore.set(cacheKey, {
      state: 'completed',
      fingerprint,
      statusCode,
      contentType,
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

  // Release the in-flight lock if the client disconnects before the response finishes
  res.on('close', () => {
    if (!finalized && idempotencyStore.get(cacheKey) === inFlightEntry) {
      idempotencyStore.delete(cacheKey);
    }
  });

  next();
}

/**
 * Clears the in-memory idempotency store (for testing only).
 */
export function clearIdempotencyStoreForTesting(): void {
  idempotencyStore.clear();
}
