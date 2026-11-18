import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { apiRouter } from './api/router.ts';
import { ReminderWorker } from './services/reminderWorker.ts';
import { requireAdminVaultMiddleware } from './services/vaultAuthService.ts';
import { createRateLimiter, getClientIp, securityHeadersMiddleware } from './middleware/security.ts';

// Server runtime defaults to UTC standard; user-specific timezones are dynamically resolved per session
if (!process.env.TZ) {
  process.env.TZ = process.env.APP_TIMEZONE || 'UTC';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');

const config = loadConfig();
const reminderWorker = new ReminderWorker();

// Reverse proxy trust: configurable via TRUST_PROXY env var (e.g. '1', 'loopback', 'true', or 'false' for direct exposure)
const trustProxyEnv = process.env.TRUST_PROXY?.trim().toLowerCase();
if (trustProxyEnv === 'false' || trustProxyEnv === '0') {
  app.set('trust proxy', false);
} else if (trustProxyEnv === 'true' || trustProxyEnv === '1' || !trustProxyEnv) {
  // Default to 1 hop (standard for Render / Cloudflare single reverse proxy)
  app.set('trust proxy', 1);
} else {
  app.set('trust proxy', process.env.TRUST_PROXY!.trim());
}

// Global defense-in-depth security headers (CSP, nosniff, X-Frame-Options, HSTS over HTTPS)
app.use(securityHeadersMiddleware);

// Webhook flood guard (generous for Meta bursts, protective against unauthenticated DoS)
const webhookRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 300,
  maxTrackedKeys: 2000,
  errorCode: 'WEBHOOK_RATE_LIMITED',
  message: 'Too many webhook requests.',
});

// Concurrency & rate-limiting guard for large payload import endpoint
let activeImports = 0;
const MAX_CONCURRENT_IMPORTS = 1;
const MAX_TRACKED_IPS = 1000;
const importRateLimitWindowMs = 60 * 1000;
const importIpRequests = new Map<string, { count: number; resetAt: number }>();

function pruneExpiredImportIps(now: number): void {
  for (const [k, v] of importIpRequests.entries()) {
    if (v.resetAt <= now) importIpRequests.delete(k);
  }
}

// Periodic unref'd sweep to clean up expired rate-limit records without per-request overhead
const ipCleanupInterval = setInterval(() => {
  pruneExpiredImportIps(Date.now());
}, importRateLimitWindowMs);
ipCleanupInterval.unref();

function archiveImportGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = getClientIp(req);
  const now = Date.now();

  const ipRecord = importIpRequests.get(ip);
  if (ipRecord && ipRecord.resetAt > now) {
    if (ipRecord.count >= 5) {
      const retryAfterSec = Math.max(1, Math.ceil((ipRecord.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ success: false, error: 'Too many import requests. Please wait a minute before retrying.' });
      return;
    }
    ipRecord.count++;
  } else {
    if (ipRecord) {
      importIpRequests.delete(ip);
    }
    if (importIpRequests.size >= MAX_TRACKED_IPS) {
      pruneExpiredImportIps(now);
    }
    if (importIpRequests.size >= MAX_TRACKED_IPS) {
      const oldestIp = importIpRequests.keys().next().value;
      if (oldestIp !== undefined) {
        importIpRequests.delete(oldestIp);
      }
    }
    importIpRequests.set(ip, { count: 1, resetAt: now + importRateLimitWindowMs });
  }

  if (activeImports >= MAX_CONCURRENT_IMPORTS) {
    res.setHeader('Retry-After', '5');
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

  // Always release the capacity slot when response finishes or if connection aborts before handler starts
  res.on('finish', release);
  res.on('close', () => {
    if (!handlerStarted) {
      release();
    }
  });

  next();
}

// Authenticate admin BEFORE allocating 50MB parser or claiming concurrency slot
app.use('/api/archive/import', requireAdminVaultMiddleware, archiveImportGuard, express.json({ limit: '50mb' }));

// Route-specific parser for Meta webhooks with flood guard and raw body retention for HMAC verification (1MB)
app.use(['/api/instagram/webhook', '/webhook'], webhookRateLimiter.middleware, express.json({
  limit: '1mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Default bounded JSON parser for general endpoints (1MB)
app.use(express.json({ limit: '1mb' }));

// API Routes
app.use('/api', apiRouter);

// Support root /webhook alias for Meta Instagram webhook callback
app.use('/webhook', (req, res, next) => {
  req.url = '/instagram/webhook' + (req.url === '/' ? '' : req.url);
  apiRouter(req, res, next);
});

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

// Sanitized JSON error handler for malformed payloads, oversize bodies, and unexpected errors
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Request payload exceeds the maximum allowed size.' });
    return;
  }
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && (err as any).status === 400)) {
    res.status(400).json({ error: 'INVALID_JSON', message: 'Request body must be valid JSON.' });
    return;
  }
  console.error('[Server] Unhandled request error:', err);
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred.' });
});

const PORT = config.server.port;
const server = app.listen(PORT, () => {
  console.log('================================================================');
  console.log(`Reeler (Instagram Saved Reels Tracker) running on http://localhost:${PORT}`);
  console.log('================================================================');
  console.log(`- Database:    ${config.supabase.isConfigured ? 'Supabase (' + config.supabase.url + ')' : 'In-Memory (Development/Demo Mode)'}`);
  console.log(`- Reminders:   Default interval: ${config.reminders.defaultIntervalHours} hours`);
  if (
    process.env.NODE_ENV === 'production' &&
    !process.env.VAULT_SECRET?.trim() &&
    !process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() &&
    !process.env.SUPABASE_ANON_KEY?.trim()
  ) {
    console.warn('[Security] WARNING: Running in production without VAULT_SECRET or Supabase key configured!');
  }
  console.log('================================================================\n');

  reminderWorker.start();
});

// Slowloris and idle-connection hardening
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
