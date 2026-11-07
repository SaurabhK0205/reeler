import express from 'express';
import type { Request, Response } from 'express';
import { Repository } from '../db/repository.ts';
import { SyncService } from '../services/syncService.ts';
import { loadConfig } from '../config.ts';
import { MetaInstagramBotService } from '../services/metaInstagramBotService.ts';
import type { ReelQueryFilters, WatchStatus, DateFilterPreset } from '../types.ts';

export const apiRouter = express.Router();
const syncService = new SyncService();
const metaBotService = new MetaInstagramBotService();

// Instagram Webhook Verification (Meta calls this once when setting up)
apiRouter.get('/instagram/webhook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  const verified = metaBotService.verifyWebhook(mode, token, challenge);
  if (verified) {
    console.log('[MetaIG] Webhook verification succeeded!');
    res.status(200).send(challenge);
  } else {
    console.warn('[MetaIG] Webhook verification failed. Tokens mismatch.');
    res.sendStatus(403);
  }
});

// Instagram Webhook Event Handler (Meta or ManyChat sends incoming DMs here)
apiRouter.post('/instagram/webhook', async (req: Request, res: Response) => {
  try {
    // Acknowledge immediately to prevent timeouts from Meta
    res.status(200).send('EVENT_RECEIVED');
    await metaBotService.handleWebhookPayload(req.body);
  } catch (err: any) {
    console.error('[MetaIG] Error handling webhook payload:', err.message);
  }
});

// Health check and configuration status
apiRouter.get('/health', (_req: Request, res: Response) => {
  const config = loadConfig();
  res.json({
    status: 'ok',
    database: config.supabase.isConfigured ? 'supabase' : 'in-memory-demo',
    instagramConfigured: config.instagram.isConfigured,
  });
});

// Get library overview statistics
apiRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await Repository.getStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get creators with their saved reels count
apiRouter.get('/creators', async (_req: Request, res: Response) => {
  try {
    const creators = await Repository.getCreators();
    res.json(creators);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get reels with compound filtering, search, and pagination
apiRouter.get('/reels', async (req: Request, res: Response) => {
  try {
    const filters: ReelQueryFilters = {
      creatorId: req.query.creatorId as string || undefined,
      datePreset: (req.query.datePreset as DateFilterPreset) || 'all',
      startDate: req.query.startDate as string || undefined,
      endDate: req.query.endDate as string || undefined,
      watchStatus: (req.query.watchStatus as WatchStatus | 'all') || 'all',
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

// Update watch status of a Reel
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

// Trigger synchronization
apiRouter.post('/sync', async (req: Request, res: Response) => {
  try {
    const config = loadConfig();
    if (!config.instagram.isConfigured) {
      res.status(400).json({
        error: 'Instagram session is not configured. Add your cookies to .env first.',
      });
      return;
    }

    const maxPages = Number(req.body?.maxPages) || 5;
    const result = await syncService.syncSavedReels(maxPages);

    if (!result.success) {
      res.status(500).json({ error: result.error.message });
      return;
    }

    res.json({ success: true, ...result.data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
