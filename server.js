import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(join(__dirname, 'public')));

// Railway provides a persistent volume path via RAILWAY_VOLUME_MOUNT_PATH when a volume
// is attached; fall back to local file otherwise.
const dbPath = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'seedspire.db')
      : join(__dirname, 'seedspire.db'));

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS saves (
    id TEXT PRIMARY KEY,
    seed TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    seed TEXT NOT NULL,
    floor INTEGER NOT NULL,
    level INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// New run: hand the client a fresh seed (or accept a chosen text seed).
app.post('/api/new', (req, res) => {
  const seed = (req.body?.seed && String(req.body.seed).trim()) || randomUUID().slice(0, 8);
  const id = randomUUID();
  res.json({ id, seed });
});

// Save / load a run so a player can resume across sessions.
app.put('/api/save/:id', (req, res) => {
  const { id } = req.params;
  const { seed, state } = req.body || {};
  if (!seed || !state) return res.status(400).json({ error: 'seed and state required' });
  db.prepare(`INSERT INTO saves (id, seed, state, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET seed=excluded.seed, state=excluded.state, updated_at=excluded.updated_at`)
    .run(id, String(seed), JSON.stringify(state), Date.now());
  res.json({ ok: true });
});

app.get('/api/save/:id', (req, res) => {
  const row = db.prepare('SELECT seed, state, updated_at FROM saves WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ seed: row.seed, state: JSON.parse(row.state), updated_at: row.updated_at });
});

// Leaderboard.
app.post('/api/score', (req, res) => {
  const { name, seed, floor, level } = req.body || {};
  if (!name || floor == null) return res.status(400).json({ error: 'invalid' });
  db.prepare('INSERT INTO scores (id, name, seed, floor, level, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), String(name).slice(0, 16), String(seed || ''), floor | 0, level | 0, Date.now());
  res.json({ ok: true });
});

app.get('/api/scores', (_req, res) => {
  const rows = db.prepare('SELECT name, seed, floor, level, created_at FROM scores ORDER BY floor DESC, level DESC LIMIT 20').all();
  res.json(rows);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Seedspire running on :${port} (db: ${dbPath})`));
