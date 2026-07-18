# SEEDSPIRE

A procedurally generated dungeon crawler where **the loot is the gameplay** — every weapon you find rolls its own procedural ability (shape + damage type + scaling), so what you can *do* changes with what you *wield*.

## What's procedural

- **Dungeons** — seeded BSP room-and-corridor generation, guaranteed fully connected, difficulty scaling per floor, bosses every 5th floor. Same seed → same spire, every time.
- **Loot** — affix system (prefixes/suffixes) over base types, five rarity tiers (Common→Legendary) with weighted drop rates and item-level scaling.
- **Abilities** — each weapon generates a skill from a pool of delivery *shapes* (bolt, nova, cleave, lance, volley, chain) × damage *types* (physical, fire, cold, lightning, void) with rolled power/cooldown. Equip a different weapon, play a different way.

Everything derives deterministically from a text seed, so a seed can be shared and replayed.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Controls

- **WASD / arrows** — move
- **J** or **click/hold** — primary ability (from your weapon)
- **L** — secondary ability (off-hand weapon)
- **K / space** — dash (brief i-frames)
- **I** — inventory / equipment
- Step on **▼** to descend (clear the boss first on boss floors)

Mobile: on-screen stick + attack button appear automatically.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Railway auto-detects Node (Nixpacks) and runs `npm start`. No env vars required — it listens on `PORT` automatically.
4. (Optional, for persistent saves + leaderboard across redeploys) Add a **Volume** to the service. The server writes its SQLite DB to `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached; otherwise it falls back to a local file (wiped on redeploy).

That's it — the whole game is static assets served by one Express process plus a tiny SQLite-backed API for saves, scores, and seeds.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/new` | Start a run, get an id + seed |
| PUT | `/api/save/:id` | Persist run state |
| GET | `/api/save/:id` | Resume a run |
| POST | `/api/score` | Submit to leaderboard on death |
| GET | `/api/scores` | Top 20 deepest descents |

## Stack

Node + Express + better-sqlite3, vanilla JS canvas client (no build step). `public/gen.js` is shared, pure, and deterministic — the single source of truth for all generation.
