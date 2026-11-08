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

// Route-specific bounded parser for official Instagram archive imports (up to 50MB)
app.use('/api/archive/import', express.json({ limit: '50mb' }));

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
