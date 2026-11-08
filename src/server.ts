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

app.use(express.json({ limit: '50mb' }));

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
