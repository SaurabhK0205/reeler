import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { apiRouter } from './api/router.ts';
import { ReminderWorker } from './services/reminderWorker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const config = loadConfig();
const reminderWorker = new ReminderWorker();

// Concurrency & rate-limiting guard for large payload import endpoint
let activeImports = 0;
const MAX_CONCURRENT_IMPORTS = 1;
const importRateLimitWindowMs = 60 * 1000;
const importIpRequests = new Map<string, { count: number; resetAt: number }>();

function archiveImportGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const ipRecord = importIpRequests.get(ip);
  if (ipRecord && ipRecord.resetAt > now) {
    if (ipRecord.count >= 5) {
      res.status(429).json({ success: false, error: 'Too many import requests. Please wait a minute before retrying.' });
      return;
    }
    ipRecord.count++;
  } else {
    importIpRequests.set(ip, { count: 1, resetAt: now + importRateLimitWindowMs });
  }

  if (importIpRequests.size > 1000) {
    for (const [k, v] of importIpRequests.entries()) {
      if (v.resetAt <= now) importIpRequests.delete(k);
    }
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
  const release = () => {
    if (!completed) {
      completed = true;
      activeImports = Math.max(0, activeImports - 1);
    }
  };

  res.on('finish', release);
  res.on('close', release);
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

// Fallback to index.html for SPA-style routing
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log('================================================================');
  console.log(` 🚀 Reeler (Instagram Saved Reels Tracker) running on http://localhost:${PORT}`);
  console.log('================================================================');
  console.log(`- Database:    ${config.supabase.isConfigured ? 'Supabase (' + config.supabase.url + ')' : 'In-Memory (Development/Demo Mode)'}`);
  console.log(`- Reminders:   Default interval: ${config.reminders.defaultIntervalHours} hours`);
  console.log('================================================================\n');

  reminderWorker.start();
});
