import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { apiRouter } from './api/router.ts';
import { ReminderWorker } from './services/reminderWorker.ts';

// Server runtime defaults to UTC standard; user-specific timezones are dynamically resolved per session
if (!process.env.TZ) {
  process.env.TZ = process.env.APP_TIMEZONE || 'UTC';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const config = loadConfig();
const reminderWorker = new ReminderWorker();

// Reverse proxy trust: configurable via TRUST_PROXY env var (e.g. '1', 'loopback', 'true', or 'false' for direct exposure)
const trustProxyEnv = process.env.TRUST_PROXY?.trim().toLowerCase();
if (trustProxyEnv === 'false' || trustProxyEnv === '0') {
  app.set('trust proxy', false);
} else if (trustProxyEnv === 'true' || trustProxyEnv === '1' || !trustProxyEnv) {
  // Default to 1 hop (standard for Cloudflare Tunnel or single reverse proxy)
  app.set('trust proxy', 1);
} else {
  app.set('trust proxy', process.env.TRUST_PROXY!.trim());
}

// Concurrency & rate-limiting guard for large payload import endpoint
let activeImports = 0;
const MAX_CONCURRENT_IMPORTS = 1;
const MAX_TRACKED_IPS = 1000;
const importRateLimitWindowMs = 60 * 1000;
const importIpRequests = new Map<string, { count: number; resetAt: number }>();

// Periodic unref'd sweep to clean up expired rate-limit records without per-request overhead
const ipCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of importIpRequests.entries()) {
    if (v.resetAt <= now) importIpRequests.delete(k);
  }
}, importRateLimitWindowMs);
ipCleanupInterval.unref();

function archiveImportGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const ipRecord = importIpRequests.get(ip);
  if (ipRecord && ipRecord.resetAt > now) {
    if (ipRecord.count >= 5) {
      res.status(429).json({ success: false, error: 'Too many import requests. Please wait a minute before retrying.' });
      return;
    }
    ipRecord.count++;
  } else {
    if (importIpRequests.size >= MAX_TRACKED_IPS) {
      res.status(429).json({ success: false, error: 'Import rate limit capacity reached. Please retry later.' });
      return;
    }
    importIpRequests.set(ip, { count: 1, resetAt: now + importRateLimitWindowMs });
  }

  if (activeImports >= MAX_CONCURRENT_IMPORTS) {
    res.status(429).json({
      success: false,
      error: 'An archive import is currently in progress. Please wait for it to complete.',
    });
    return;
  }

  activeImports++;
  let completed = false;
  let handlerStarted = false;

  const release = () => {
    if (!completed) {
      completed = true;
      activeImports = Math.max(0, activeImports - 1);
    }
  };

  (req as any).markHandlerStarted = () => {
    handlerStarted = true;
  };
  (req as any).releaseImportSlot = release;

  // If the connection drops before the handler begins execution, release the capacity slot
  res.on('close', () => {
    if (!handlerStarted) {
      release();
    }
  });

  next();
}

// Route-specific bounded parser for official Instagram archive imports (up to 50MB) protected by guard
app.use('/api/archive/import', archiveImportGuard, express.json({ limit: '50mb' }));

// Route-specific parser for Meta webhooks with raw body retention for HMAC verification (1MB)
app.use('/api/instagram/webhook', express.json({
  limit: '1mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Default bounded JSON parser for general endpoints (1MB)
app.use(express.json({ limit: '1mb' }));

// API Routes
app.use('/api', apiRouter);

// Static Frontend files
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// Explicit compliance pages for Meta App Review and platform policies
app.get(['/privacy', '/privacy.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'privacy.html'));
});
app.get(['/terms', '/terms.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'terms.html'));
});
app.get(['/data-deletion', '/data-deletion.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'data-deletion.html'));
});

// Avoid falling through to the 19 KB HTML SPA shell on browser favicon probes
app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

// Fallback to index.html for SPA-style routing
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`Reeler (Instagram Saved Reels Tracker) running on http://localhost:${PORT}`);
  console.log('================================================================');
  console.log(`- Database:    ${config.supabase.isConfigured ? 'Supabase (' + config.supabase.url + ')' : 'In-Memory (Development/Demo Mode)'}`);
  console.log(`- Reminders:   Default interval: ${config.reminders.defaultIntervalHours} hours`);
  console.log('================================================================\n');

  reminderWorker.start();
});
