import express from 'express';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { UPGRADES, nextCost } from './public/upgrades.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(join(__dirname, 'public')));

// Where the SQLite database lives. Priority:
//   1. DB_PATH env var (explicit override)
//   2. Railway's attached volume (persists across restarts/deploys)
//   3. A local file in the project folder — EPHEMERAL on Railway: this gets wiped
//      on every restart/deploy, so accounts won't survive without a volume.
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dbPath = process.env.DB_PATH
  || (volumePath ? join(volumePath, 'seedspire.db') : join(__dirname, 'seedspire.db'));

const persistent = !!(process.env.DB_PATH || volumePath);
if (!persistent) {
  console.warn('\n⚠️  WARNING: No persistent volume detected. The database is on ephemeral');
  console.warn('   container storage and will be WIPED on every restart/redeploy.');
  console.warn('   Accounts and essence will NOT survive. Attach a Railway Volume and');
  console.warn('   the app will use it automatically (via RAILWAY_VOLUME_MOUNT_PATH).\n');
} else {
  console.log(`✓ Using persistent database at: ${dbPath}`);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    username_lc TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    essence TEXT NOT NULL DEFAULT '{}',
    upgrades TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saves (
    id TEXT PRIMARY KEY,
    account_id TEXT,
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
// Migrate: add account_id to saves if an older DB predates it.
try { db.prepare('SELECT account_id FROM saves LIMIT 1').get(); }
catch { db.exec('ALTER TABLE saves ADD COLUMN account_id TEXT'); }
// Migrate: add upgrades column to accounts if an older DB predates it.
try { db.prepare('SELECT upgrades FROM accounts LIMIT 1').get(); }
catch { db.exec("ALTER TABLE accounts ADD COLUMN upgrades TEXT NOT NULL DEFAULT '{}'"); }

const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

// ---------- auth helpers ----------
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expected) {
  const actual = scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(actual, 'hex'), b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function newSession(accountId) {
  const token = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, account_id, created_at) VALUES (?, ?, ?)').run(token, accountId, Date.now());
  return token;
}
// Middleware: resolve Bearer token -> req.account. Optional unless `required`.
function auth(required) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token) {
      const sess = db.prepare('SELECT account_id FROM sessions WHERE token = ?').get(token);
      if (sess) {
        req.account = db.prepare('SELECT id, username, essence, upgrades FROM accounts WHERE id = ?').get(sess.account_id);
      }
    }
    if (required && !req.account) return res.status(401).json({ error: 'auth required' });
    next();
  };
}
function emptyEssence() { return TIERS.reduce((o, t) => (o[t] = 0, o), {}); }
function accountPayload(acc) {
  const essence = { ...emptyEssence(), ...JSON.parse(acc.essence || '{}') };
  const upgrades = JSON.parse(acc.upgrades || '{}');
  return { username: acc.username, essence, upgrades };
}

// ---------- account routes ----------
app.post('/api/register', (req, res) => {
  let { username, password } = req.body || {};
  username = String(username || '').trim();
  password = String(password || '');
  if (username.length < 3 || username.length > 16 || !/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: 'Username must be 3-16 letters, numbers, or underscore.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const exists = db.prepare('SELECT id FROM accounts WHERE username_lc = ?').get(username.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Username already taken.' });
  const { hash, salt } = hashPassword(password);
  const id = randomUUID();
  db.prepare(`INSERT INTO accounts (id, username, username_lc, pass_hash, pass_salt, essence, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, username, username.toLowerCase(), hash, salt, JSON.stringify(emptyEssence()), Date.now());
  const token = newSession(id);
  const acc = db.prepare('SELECT id, username, essence, upgrades FROM accounts WHERE id = ?').get(id);
  res.json({ token, account: accountPayload(acc) });
});

app.post('/api/login', (req, res) => {
  let { username, password } = req.body || {};
  username = String(username || '').trim().toLowerCase();
  password = String(password || '');
  const acc = db.prepare('SELECT * FROM accounts WHERE username_lc = ?').get(username);
  if (!acc || !verifyPassword(password, acc.pass_salt, acc.pass_hash))
    return res.status(401).json({ error: 'Wrong username or password.' });
  const token = newSession(acc.id);
  res.json({ token, account: accountPayload(acc) });
});

app.post('/api/logout', auth(false), (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

// Current account (used on page load to restore a session).
app.get('/api/me', auth(true), (req, res) => {
  res.json({ account: accountPayload(req.account) });
});

// Bank essence. amounts = {common: n, uncommon: n, ...}. keepFraction is applied
// server-side (1.0 for a clean extract, 0.3 for a death). Server owns the math so
// it stays authoritative for future multiplayer.
app.post('/api/essence/bank', auth(true), (req, res) => {
  const { amounts, keepFraction } = req.body || {};
  const frac = keepFraction === 0.3 ? 0.3 : 1.0;   // only two legal values
  const cur = { ...emptyEssence(), ...JSON.parse(req.account.essence || '{}') };
  const gained = emptyEssence();
  for (const t of TIERS) {
    const n = Math.max(0, Math.floor(Number(amounts?.[t]) || 0));
    gained[t] = Math.floor(n * frac);
    cur[t] += gained[t];
  }
  db.prepare('UPDATE accounts SET essence = ? WHERE id = ?').run(JSON.stringify(cur), req.account.id);
  res.json({ essence: cur, gained });
});

// Purchase the next level of an upgrade. Server is authoritative: it looks up the
// real cost from the shared catalog, checks the player can afford it and meets any
// prerequisite, deducts essence, and increments the level. The client cannot set
// its own price or grant itself upgrades.
app.post('/api/upgrade/buy', auth(true), (req, res) => {
  const { id } = req.body || {};
  const up = UPGRADES.find((u) => u.id === id);
  if (!up) return res.status(400).json({ error: 'Unknown upgrade.' });
  const essence = { ...emptyEssence(), ...JSON.parse(req.account.essence || '{}') };
  const upgrades = JSON.parse(req.account.upgrades || '{}');
  const price = nextCost(up, upgrades);
  if (!price) return res.status(400).json({ error: 'Already maxed or prerequisite not met.' });
  // affordability
  for (const [tier, amt] of Object.entries(price)) {
    if ((essence[tier] || 0) < amt) return res.status(400).json({ error: `Not enough ${tier} essence.` });
  }
  // deduct + apply
  for (const [tier, amt] of Object.entries(price)) essence[tier] -= amt;
  upgrades[id] = (upgrades[id] || 0) + 1;
  db.prepare('UPDATE accounts SET essence = ?, upgrades = ? WHERE id = ?')
    .run(JSON.stringify(essence), JSON.stringify(upgrades), req.account.id);
  res.json({ essence, upgrades });
});

// ---------- run routes (now account-aware) ----------
app.post('/api/new', (req, res) => {
  const seed = (req.body?.seed && String(req.body.seed).trim()) || randomUUID().slice(0, 8);
  const id = randomUUID();
  res.json({ id, seed });
});

app.put('/api/save/:id', auth(false), (req, res) => {
  const { id } = req.params;
  const { seed, state } = req.body || {};
  if (!seed || !state) return res.status(400).json({ error: 'seed and state required' });
  db.prepare(`INSERT INTO saves (id, account_id, seed, state, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET seed=excluded.seed, state=excluded.state, updated_at=excluded.updated_at`)
    .run(id, req.account?.id || null, String(seed), JSON.stringify(state), Date.now());
  res.json({ ok: true });
});

app.get('/api/save/:id', (req, res) => {
  const row = db.prepare('SELECT seed, state, updated_at FROM saves WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ seed: row.seed, state: JSON.parse(row.state), updated_at: row.updated_at });
});

// Delete a save so a finished run (extracted or died) can't be resumed.
app.delete('/api/save/:id', (req, res) => {
  db.prepare('DELETE FROM saves WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/score', auth(false), (req, res) => {
  const { name, seed, floor, level } = req.body || {};
  if (floor == null) return res.status(400).json({ error: 'invalid' });
  const who = req.account?.username || String(name || 'Wanderer').slice(0, 16);
  db.prepare('INSERT INTO scores (id, name, seed, floor, level, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), who, String(seed || ''), floor | 0, level | 0, Date.now());
  res.json({ ok: true });
});

app.get('/api/scores', (_req, res) => {
  const rows = db.prepare('SELECT name, seed, floor, level, created_at FROM scores ORDER BY floor DESC, level DESC LIMIT 20').all();
  res.json(rows);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Diagnostic: check whether the DB is persistent and how many accounts exist.
// Visit /api/status in your browser to confirm the volume is working.
app.get('/api/status', (_req, res) => {
  let accounts = 0;
  try { accounts = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n; } catch {}
  res.json({
    persistent,
    storage: persistent ? 'volume (survives restarts)' : 'ephemeral (WIPED on restart!)',
    dbPath,
    accounts,
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Seedspire running on :${port} (db: ${dbPath})`));
