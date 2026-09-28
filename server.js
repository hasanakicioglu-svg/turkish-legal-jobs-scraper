import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

const app = express();
const startedAt = new Date().toISOString();
const runs = new Map();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'https://hasan-legal-radar-tr.hasan-akicioglu.chatgpt.site')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(express.json({ limit: '64kb' }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'hasan-legal-radar-runner', startedAt });
});

app.post('/runs', (req, res) => {
  const runId = `manual-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const run = {
    runId,
    status: 'accepted',
    scope: req.body?.scope || 'full',
    source: req.body?.source || 'manual',
    requestedAt: new Date().toISOString(),
    note: 'Test endpoint only. Full scan engine is not attached yet.'
  };
  runs.set(runId, run);
  res.status(202).json(run);
});

app.get('/runs/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  return res.json(run);
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const port = Number(process.env.PORT || 10000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Hasan Legal Radar runner listening on ${port}`);
});
