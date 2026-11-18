import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { Repository, SenderDeletionBarrierError } from '../db/repository.ts';
import { ArchiveImportService } from '../services/archiveImportService.ts';
import { loadConfig } from '../config.ts';
import { MetaInstagramBotService } from '../services/metaInstagramBotService.ts';
import { getTimeZoneSummary, resolveTimeZone } from '../utils/timezone.ts';
import { feedMetaCacheControl, isValidShortcode, resolveFeedMediaMetadata } from '../services/reelMetadataResolver.ts';
import {
  vaultAuthMiddleware,
  verifyOtp,
  otpVerifyRateLimiter,
  otpRequestRateLimiter,
  recordOtpFailure,
  resetOtpAttempts,
  requestOtpForUsername,
} from '../services/vaultAuthService.ts';
import { createRateLimiter, getClientIp, setResponseHeader } from '../middleware/security.ts';
import { idempotencyMiddleware } from '../middleware/idempotency.ts';
import type { ReelQueryFilters, WatchStatus, DateFilterPreset, SavedMediaType, SavedCollectionSource } from '../types.ts';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_REEL_ID_RE = /^[\x21-\x7E]{1,128}$/;

const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  maxTrackedKeys: 5000,
  errorCode: 'API_RATE_LIMITED',
  message: 'Too many requests. Please slow down and try again shortly.',
  skip: (req) => req.path === '/health' || req.path.startsWith('/instagram/webhook'),
});

const mutationRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 40,
  maxTrackedKeys: 5000,
  errorCode: 'MUTATION_RATE_LIMITED',
  message: 'Too many write requests. Please wait a moment before trying again.',
  keyGenerator: (req) => {
    const principal = req.vaultUser?.role === 'admin'
      ? 'admin'
      : req.vaultUser?.senderId
        ? `user:${req.vaultUser.senderId}`
        : `ip:${getClientIp(req)}`;
    return `${principal}:${getClientIp(req)}`;
  },
  skip: (req) =>
    !MUTATING_METHODS.has(req.method.toUpperCase()) ||
    req.path.startsWith('/instagram/webhook') ||
    req.path.startsWith('/auth/otp'),
});

export function resetApiRateLimitersForTesting(): void {
  apiRateLimiter.resetForTesting();
  mutationRateLimiter.resetForTesting();
}

/**
 * Express API router handling Meta webhooks, vault queries, metadata resolution, status updates, and archive imports.
 */
export const apiRouter = express.Router();
const metaBotService = new MetaInstagramBotService();

apiRouter.use(apiRateLimiter.middleware);
apiRouter.use(vaultAuthMiddleware);
apiRouter.use(mutationRateLimiter.middleware);
apiRouter.use(idempotencyMiddleware);

/**
 * Verifies Meta Instagram webhook subscriptions using the configured verify token.
 */
apiRouter.get('/instagram/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const verified = metaBotService.verifyWebhook(mode, token, challenge);
  if (verified) {
    console.log('[MetaIG] Webhook verification succeeded!');
    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(challenge);
  } else {
    console.warn('[MetaIG] Webhook verification failed. Tokens mismatch.');
    res.sendStatus(403);
  }
});

/**
 * Verifies X-Hub-Signature-256 on incoming Meta webhook events and dispatches asynchronous handling.
 */
apiRouter.post('/instagram/webhook', async (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (req as any).rawBody;

  if (!metaBotService.verifySignature(rawBody, signature)) {
    console.warn('[MetaIG] Webhook signature verification failed. Unauthorized request.');
    res.status(401).send('Invalid signature');
    return;
  }

  try {
    // Acknowledge immediately to prevent timeouts from Meta
    res.status(200).send('EVENT_RECEIVED');
    await metaBotService.handleWebhookPayload(req.body);
  } catch (err: any) {
    console.error('[MetaIG] Error handling webhook payload:', err.message);
  }
});

/**
 * Returns server health and active storage/Instagram configuration status.
 */
apiRouter.get('/health', (_req: Request, res: Response) => {
  const config = loadConfig();
  res.json({
    status: 'ok',
    database: config.supabase.isConfigured ? 'supabase' : 'in-memory-demo',
    instagramConfigured: config.instagram.isConfigured,
    metaBotConfigured: Boolean(process.env.META_PAGE_ACCESS_TOKEN),
  });
});

/**
 * Returns current authenticated session details.
 */
apiRouter.get('/session', (req: Request, res: Response) => {
  setResponseHeader(res, 'Cache-Control', 'no-store');
  res.json({
    authenticated: Boolean(req.vaultUser),
    role: req.vaultUser?.role || 'anonymous',
    senderId: req.vaultUser?.senderId || null,
  });
});

/**
 * Verifies a 6-digit login code and returns the user's permanent vault access key.
 */
apiRouter.post('/auth/otp/verify', otpVerifyRateLimiter, (req: Request, res: Response) => {
  setResponseHeader(res, 'Cache-Control', 'no-store');
  const ip = getClientIp(req);
  if (typeof req.body?.code !== 'string' || req.body.code.length > 20) {
    recordOtpFailure(ip);
    res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'The code field must be a valid string.',
    });
    return;
  }

  const verification = verifyOtp(req.body.code);

  if (!verification.valid || !verification.vaultKey) {
    recordOtpFailure(ip);
    res.status(400).json({
      error: 'INVALID_OR_EXPIRED_CODE',
      message: 'This 6-digit code is invalid, expired, or already used (codes are single-use). Send "code" to @er_reel_er on Instagram for a fresh code.',
    });
    return;
  }

  resetOtpAttempts(ip);
  res.json({
    success: true,
    vaultKey: verification.vaultKey,
    role: verification.session?.role,
    senderId: verification.session?.senderId || null,
  });
});

/**
 * Dispatches a 6-digit login code to the user's Instagram DM if their handle is mapped.
 */
apiRouter.post('/auth/otp/request', otpRequestRateLimiter, async (req: Request, res: Response) => {
  setResponseHeader(res, 'Cache-Control', 'no-store');
  if (typeof req.body?.username !== 'string' || req.body.username.length > 50) {
    res.status(400).json({
      error: 'INVALID_REQUEST',
      message: 'The username field must be a valid string.',
    });
    return;
  }

  const result = await requestOtpForUsername(
    req.body.username,
    (recipientId, text) => metaBotService.sendDirectMessage(recipientId, text),
    metaBotService.adminUserId
  );

  const httpStatus = result.success
    ? 200
    : result.code === 'DELIVERY_FAILED'
      ? 502
      : result.code === 'OTP_CAPACITY_REACHED'
        ? 503
        : 200;
  res.status(httpStatus).json(result);
});

/**
 * Returns aggregate saved-reel and creator counts for the vault header telemetry.
 */
apiRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    setResponseHeader(res, 'Cache-Control', 'no-store');
    const senderId = req.vaultUser?.role === 'admin' ? undefined : req.vaultUser?.senderId;
    const stats = await Repository.getStats(senderId);
    res.json(stats);
  } catch (error: any) {
    console.error('[API] Error in GET /stats:', error);
    res.status(500).json({ error: 'Failed to load vault statistics.' });
  }
});

/**
 * Returns saved creators ordered by saved reel count descending, supporting optional search (`q`),
 * bounding (`limit`), and pinned active ID (`includeId`) to avoid shipping the entire creator directory.
 */
apiRouter.get('/creators', async (req: Request, res: Response) => {
  try {
    setResponseHeader(res, 'Cache-Control', 'no-store');
    const senderId = req.vaultUser?.role === 'admin' ? undefined : req.vaultUser?.senderId;
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(100, Math.floor(rawLimit))
      : undefined;
    const includeId = typeof req.query.includeId === 'string' && req.query.includeId.trim()
      ? req.query.includeId.trim().slice(0, 128)
      : undefined;

    if (q !== undefined || limit !== undefined || includeId !== undefined) {
      const { creators, totalCount, matchCount } = await Repository.queryCreators({
        q,
        limit,
        includeId,
        instagramSenderId: senderId,
      });
      res.setHeader('X-Total-Count', String(totalCount));
      res.setHeader('X-Match-Count', String(matchCount));
      res.json(creators);
      return;
    }

    const creators = await Repository.getCreators(senderId);
    res.setHeader('X-Total-Count', String(creators.length));
    res.setHeader('X-Match-Count', String(creators.length));
    res.json(creators);
  } catch (error: any) {
    console.error('[API] Error in GET /creators:', error);
    res.status(500).json({ error: 'Failed to load creators.' });
  }
});

/**
 * Returns paginated saved reels filtered by creator, date range, watch status, and search query.
 */
apiRouter.get('/reels', async (req: Request, res: Response) => {
  try {
    setResponseHeader(res, 'Cache-Control', 'no-store');
    const senderId = req.vaultUser?.role === 'admin' ? undefined : req.vaultUser?.senderId;
    const rawMediaType = typeof req.query.mediaType === 'string' ? req.query.mediaType.trim().toLowerCase() : '';
    if (rawMediaType && rawMediaType !== 'all' && rawMediaType !== 'reel' && rawMediaType !== 'post') {
      res.status(400).json({ error: 'Invalid mediaType filter' });
      return;
    }

    const rawSource = typeof req.query.source === 'string' ? req.query.source.trim().toLowerCase() : '';
    if (rawSource && rawSource !== 'all' && rawSource !== 'instagram' && rawSource !== 'bot') {
      res.status(400).json({ error: 'Invalid source filter' });
      return;
    }

    const parsedPage = Number(req.query.page);
    const parsedLimit = Number(req.query.limit);
    const safePage = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.min(10000, Math.floor(parsedPage)) : 1;
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? Math.min(100, Math.floor(parsedLimit)) : 24;
    const safeSearch = typeof req.query.search === 'string' && req.query.search.trim()
      ? req.query.search.trim().slice(0, 200)
      : undefined;
    const safeCreatorId = typeof req.query.creatorId === 'string' && req.query.creatorId.trim()
      ? req.query.creatorId.trim().slice(0, 128)
      : undefined;

    const filters: ReelQueryFilters = {
      creatorId: safeCreatorId,
      instagramSenderId: senderId,
      datePreset: (req.query.datePreset as DateFilterPreset) || 'all',
      startDate: typeof req.query.startDate === 'string' ? req.query.startDate.slice(0, 40) : undefined,
      endDate: typeof req.query.endDate === 'string' ? req.query.endDate.slice(0, 40) : undefined,
      watchStatus: (req.query.watchStatus as WatchStatus | 'all') || 'all',
      mediaType: (rawMediaType as SavedMediaType | 'all') || 'all',
      source: (rawSource as SavedCollectionSource | 'all') || 'all',
      search: safeSearch,
      sortBy: (req.query.sortBy as any) || 'newest_saved',
      page: safePage,
      limit: safeLimit,
    };

    const result = await Repository.getReels(filters);
    res.json(result);
  } catch (error: any) {
    console.error('[API] Error in GET /reels:', error);
    res.status(500).json({ error: 'Failed to load saved reels.' });
  }
});

/**
 * Resolves live media kind and cover aspect ratio for an Instagram shortcode with disconnect cancellation
 * and bounded upstream concurrency.
 */
apiRouter.get('/reels/:shortcode/meta', async (req: Request, res: Response) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const shortcode = String(req.params.shortcode || '');
    if (!isValidShortcode(shortcode)) {
      res.status(400).json({ error: 'Invalid shortcode format' });
      return;
    }

    const rawTypeHint = typeof req.query.type === 'string' ? req.query.type.trim().toLowerCase() : '';
    const preferredPath =
      rawTypeHint === 'p' || rawTypeHint === 'post'
        ? 'p'
        : rawTypeHint === 'reel'
          ? 'reel'
          : undefined;

    const meta = await resolveFeedMediaMetadata(shortcode, controller.signal, preferredPath);
    if (controller.signal.aborted || res.writableEnded) {
      return;
    }
    res.setHeader('Cache-Control', feedMetaCacheControl(meta));
    res.json(meta);
  } catch (error: any) {
    if (controller.signal.aborted || res.writableEnded) {
      return;
    }
    if (error?.name === 'AbortError') {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: 'Metadata lookup canceled, please retry' });
      return;
    }
    if (error?.code === 'RATE_LIMITED') {
      res.setHeader('Retry-After', '5');
      res.status(429).json({ error: 'Too many metadata requests, please retry shortly' });
      return;
    }
    console.error('[API] Error in GET /reels/:shortcode/meta:', error);
    res.status(500).json({ error: 'Failed to resolve media metadata.' });
  }
});

/**
 * Updates the watch status (`unwatched`, `watch_later`, `watched`) of a saved reel.
 */
apiRouter.patch('/reels/:id/status', async (req: Request, res: Response) => {
  try {
    setResponseHeader(res, 'Cache-Control', 'no-store');
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!id || !SAFE_REEL_ID_RE.test(id)) {
      res.status(400).json({ error: 'Invalid reel identifier' });
      return;
    }

    const status = req.body?.status;
    if (!['unwatched', 'watched', 'watch_later'].includes(status)) {
      res.status(400).json({ error: 'Invalid watch status' });
      return;
    }

    const senderId = req.vaultUser?.role === 'admin' ? undefined : req.vaultUser?.senderId;
    const updated = await Repository.updateWatchStatus(id, status as WatchStatus, senderId);
    if (!updated) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    res.json(updated);
  } catch (error: any) {
    console.error('[API] Error in PATCH /reels/:id/status:', error);
    res.status(500).json({ error: 'Failed to update watch status.' });
  }
});

/**
 * Imports an official Instagram `saved_posts.json` archive export into the authenticated user's vault
 * (or the unattributed admin vault for administrator sessions).
 */
apiRouter.post('/archive/import', async (req: Request, res: Response) => {
  setResponseHeader(res, 'Cache-Control', 'no-store');
  const vaultUser = req.vaultUser;
  if (!vaultUser || (vaultUser.role !== 'admin' && !vaultUser.senderId)) {
    (req as any).releaseImportSlot?.();
    res.status(403).json({ success: false, error: 'An authenticated vault session is required to import archive files.' });
    return;
  }
  const targetSenderId = vaultUser.role === 'admin' ? undefined : vaultUser.senderId;
  (req as any).markHandlerStarted?.();
  try {
    const rawData = req.body;
    if (!rawData) {
      res.status(400).json({ success: false, error: 'No data payload provided for import' });
      return;
    }

    const admissionDeletionGeneration =
      typeof (req as any).archiveAdmissionDeletionGeneration === 'number'
        ? (req as any).archiveAdmissionDeletionGeneration
        : undefined;
    const result = await ArchiveImportService.importArchive(rawData, targetSenderId, admissionDeletionGeneration);
    if (result.status === 'too_large') {
      res.status(413).json({ success: false, ...result });
      return;
    }
    if (result.status === 'empty') {
      res.status(400).json({ success: false, ...result });
      return;
    }
    if (result.status === 'failed') {
      res.status(500).json({ success: false, ...result });
      return;
    }

    res.status(200).json({ success: true, ...result });
  } catch (error: any) {
    if (error instanceof SenderDeletionBarrierError) {
      if (!res.locals) (res as any).locals = {};
      res.locals.skipIdempotencyCache = true;
      res.status(409).json({
        success: false,
        error: 'Account data deletion is currently in progress. Please try importing again shortly.',
      });
      return;
    }
    console.error('[ArchiveImport] Unexpected error in /archive/import endpoint:', error);
    res.status(500).json({ success: false, error: 'An unexpected internal error occurred during archive import.' });
  } finally {
    (req as any).releaseImportSlot?.();
  }
});

/**
 * Returns the active timezone for the authenticated vault user (or system default).
 */
apiRouter.get('/user/timezone', async (req: Request, res: Response) => {
  setResponseHeader(res, 'Cache-Control', 'no-store');
  const preferenceKey = req.vaultUser?.senderId || (req.vaultUser?.role === 'admin' ? 'admin' : null);
  const timezone = preferenceKey
    ? await Repository.getSenderTimezone(preferenceKey)
    : process.env.APP_TIMEZONE || process.env.TZ || 'UTC';
  res.json({
    timezone,
    summary: getTimeZoneSummary(timezone),
  });
});

/**
 * Updates the active timezone for the authenticated vault user.
 */
apiRouter.patch('/user/timezone', async (req: Request, res: Response, next: NextFunction) => {
  setResponseHeader(res, 'Cache-Control', 'no-store');
  const preferenceKey = req.vaultUser?.senderId || (req.vaultUser?.role === 'admin' ? 'admin' : null);
  const rawTz = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : '';

  if (!rawTz) {
    res.status(400).json({ error: 'INVALID_REQUEST', message: 'Timezone string is required.' });
    return;
  }

  const resolved = resolveTimeZone(rawTz);
  if (!resolved) {
    res.status(400).json({ error: 'INVALID_TIMEZONE', message: `Unrecognized timezone "${rawTz}".` });
    return;
  }

  if (!preferenceKey) {
    res.status(400).json({ error: 'SENDER_ID_REQUIRED', message: 'No sender ID or admin session associated with this request.' });
    return;
  }

  try {
    await Repository.setSenderTimezone(preferenceKey, resolved);
  } catch (error) {
    if (error instanceof SenderDeletionBarrierError) {
      if (!res.locals) (res as any).locals = {};
      res.locals.skipIdempotencyCache = true;
      res.status(409).json({ error: 'DELETION_IN_PROGRESS', message: error.message });
      return;
    }
    next(error);
    return;
  }

  res.json({
    success: true,
    timezone: resolved,
    summary: getTimeZoneSummary(resolved),
  });
});

