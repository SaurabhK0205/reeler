import express from 'express';
import type { Request, Response } from 'express';
import { Repository } from '../db/repository.ts';
import { ArchiveImportService } from '../services/archiveImportService.ts';
import { loadConfig } from '../config.ts';
import { MetaInstagramBotService } from '../services/metaInstagramBotService.ts';
import { feedMetaCacheControl, isValidShortcode, resolveFeedMediaMetadata } from '../services/reelMetadataResolver.ts';
import {
  vaultAuthMiddleware,
  verifyOtp,
  otpVerifyRateLimiter,
  recordOtpFailure,
  resetOtpAttempts,
  requestOtpForUsername,
} from '../services/vaultAuthService.ts';
import type { ReelQueryFilters, WatchStatus, DateFilterPreset, SavedMediaType, SavedCollectionSource } from '../types.ts';

/**
 * Express API router handling Meta webhooks, vault queries, metadata resolution, status updates, and archive imports.
 */
export const apiRouter = express.Router();
const metaBotService = new MetaInstagramBotService();

apiRouter.use(vaultAuthMiddleware);

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
  });
});

/**
 * Returns current authenticated session details.
 */
apiRouter.get('/session', (req: Request, res: Response) => {
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
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
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
      message: 'The 6-digit login code is invalid or has expired. Please message "code" to our Instagram bot to get a new code.',
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
apiRouter.post('/auth/otp/request', async (req: Request, res: Response) => {
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

  const httpStatus = result.success ? 200 : result.code === 'DELIVERY_FAILED' ? 502 : 200;
  res.status(httpStatus).json(result);
});

/**
 * Returns aggregate saved-reel and creator counts for the vault header telemetry.
 */
apiRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const senderId = req.vaultUser?.role === 'admin' ? undefined : req.vaultUser?.senderId;
    const stats = await Repository.getStats(senderId);
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Returns saved creators ordered by saved reel count descending, supporting optional search (`q`),
 * bounding (`limit`), and pinned active ID (`includeId`) to avoid shipping the entire creator directory.
 */
apiRouter.get('/creators', async (req: Request, res: Response) => {
  try {
    const senderId = req.vaultUser?.role === 'admin' ? undefined : req.vaultUser?.senderId;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(100, Math.floor(rawLimit))
      : undefined;
    const includeId = typeof req.query.includeId === 'string' && req.query.includeId.trim()
      ? req.query.includeId.trim()
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
    res.status(500).json({ error: error.message });
  }
});

/**
 * Returns paginated saved reels filtered by creator, date range, watch status, and search query.
 */
apiRouter.get('/reels', async (req: Request, res: Response) => {
  try {
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

    const filters: ReelQueryFilters = {
      creatorId: req.query.creatorId as string || undefined,
      instagramSenderId: senderId,
      datePreset: (req.query.datePreset as DateFilterPreset) || 'all',
      startDate: req.query.startDate as string || undefined,
      endDate: req.query.endDate as string || undefined,
      watchStatus: (req.query.watchStatus as WatchStatus | 'all') || 'all',
      mediaType: (rawMediaType as SavedMediaType | 'all') || 'all',
      source: (rawSource as SavedCollectionSource | 'all') || 'all',
      search: req.query.search as string || undefined,
      sortBy: (req.query.sortBy as any) || 'newest_saved',
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 24,
    };

    const result = await Repository.getReels(filters);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message || 'Failed to resolve media metadata' });
  }
});

/**
 * Updates the watch status (`unwatched`, `watch_later`, `watched`) of a saved reel.
 */
apiRouter.patch('/reels/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['unwatched', 'watched', 'watch_later'].includes(status)) {
      res.status(400).json({ error: 'Invalid watch status' });
      return;
    }

    const updated = await Repository.updateWatchStatus(id, status as WatchStatus);
    if (!updated) {
      res.status(404).json({ error: 'Reel not found' });
      return;
    }

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Imports an official Instagram `saved_posts.json` archive export into the repository.
 */
apiRouter.post('/archive/import', async (req: Request, res: Response) => {
  if (req.vaultUser?.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Only the vault administrator can import archive files.' });
    return;
  }
  (req as any).markHandlerStarted?.();
  try {
    const rawData = req.body;
    if (!rawData) {
      res.status(400).json({ success: false, error: 'No data payload provided for import' });
      return;
    }

    const result = await ArchiveImportService.importArchive(rawData);
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
    console.error('[ArchiveImport] Unexpected error in /archive/import endpoint:', error);
    res.status(500).json({ success: false, error: 'An unexpected internal error occurred during archive import.' });
  } finally {
    (req as any).releaseImportSlot?.();
  }
});
