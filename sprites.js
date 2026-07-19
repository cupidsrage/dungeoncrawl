// sprites.js — procedural pixel-art, polished pass.
//
// Upgrades over v1: a finer 24x24 pixel grid, an automatic dark-outline pass so
// every creature reads against the floor, shading via light/mid/shadow ramps,
// and a 2-frame idle animation (breathe / bob / limb shift). Each sprite is
// still drawn ONCE to an offscreen canvas per frame, then blitted each tick.

const cache = {};

function make(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  paint(g, w, h);
  return c;
}

// ---------- pixel toolkit ----------
function px(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
function dot(g, x, y, c) { g.fillStyle = c; g.fillRect(x, y, 1, 1); }

// 3-stop shade ramp {hi, mid, lo, out} from a base hex.
function ramp(hex, { hi = 0.28, lo = 0.32, out = 0.7 } = {}) {
  const [r, gr, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mix = (t) => {
    const to = t > 0 ? 255 : 0, k = Math.abs(t);
    const f = (c) => Math.round(c + (to - c) * k);
    return `#${[f(r), f(gr), f(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  };
  return { hi: mix(hi), mid: hex, lo: mix(-lo), out: mix(-out) };
}

// 1px dark outline around the silhouette (into transparent cells touching fill).
function outline(g, W, H, color = '#0a0c12') {
  let img;
  try { img = g.getImageData(0, 0, W, H); } catch { return; }  // skip if unreadable
  const a = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : img.data[(y * W + x) * 4 + 3]);
  const edges = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a(x, y) !== 0) continue;
    if (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1) ||
        a(x - 1, y - 1) || a(x + 1, y - 1) || a(x - 1, y + 1) || a(x + 1, y + 1)) edges.push([x, y]);
  }
  g.fillStyle = color;
  for (const [x, y] of edges) g.fillRect(x, y, 1, 1);
}

// Soft interior shadow on the bottom third, for volume.
function ambientOcclusion(g, W, H) {
  let img;
  try { img = g.getImageData(0, 0, W, H); } catch { return; }
  g.save(); g.globalAlpha = 0.14; g.fillStyle = '#000';
  for (let y = Math.floor(H * 0.62); y < H; y++)
    for (let x = 0; x < W; x++)
      if (img.data[(y * W + x) * 4 + 3] > 0) g.fillRect(x, y, 1, 1);
  g.restore();
}

const OUT = '#0a0c12';

// ---------- creature painters (24x24 grid), (g, f) f = frame 0|1 ----------
function grub(g, f) {
  const c = ramp('#8fae6b');
  const yb = f ? 11 : 12;
  px(g, 6, yb, 12, 8, c.mid);
  px(g, 6, yb, 12, 2, c.hi);
  px(g, 6, yb + 6, 12, 2, c.lo);
  for (const sx of [9, 12, 15]) px(g, sx, yb + 1, 1, 6, c.lo);
  px(g, 5, yb + 3, 1, 3, c.mid); px(g, 18, yb + 3, 1, 3, c.mid);
  dot(g, 8, yb + 3, '#101408'); dot(g, 15, yb + 3, '#101408');
  dot(g, 8, yb + 2, '#c8e29a'); dot(g, 15, yb + 2, '#c8e29a');
}

function skitter(g, f) {
  const c = ramp('#caa24b');
  px(g, 9, 7, 6, 8, c.mid);
  px(g, 9, 7, 6, 2, c.hi);
  px(g, 9, 12, 6, 3, c.lo);
  px(g, 10, 5, 4, 3, c.mid);
  px(g, 10, 5, 4, 1, c.hi);
  px(g, 9, 4, 1, 1, c.lo); px(g, 14, 4, 1, 1, c.lo);
  g.fillStyle = '#6b521f';
  const spread = f ? 0 : 1;
  g.fillRect(4 - spread, 8, 5, 1); g.fillRect(4 - spread, 11, 5, 1);
  g.fillRect(15, 8, 5, 1); g.fillRect(15, 11, 5, 1);
  g.fillRect(8, 15, 2, 4 - spread); g.fillRect(14, 15, 2, 4 - spread);
  dot(g, 10, 6, '#1a1206'); dot(g, 13, 6, '#1a1206');
  dot(g, 10, 5, '#ffe9a8'); dot(g, 13, 5, '#ffe9a8');
}

function brute(g, f) {
  const c = ramp('#8a8073', { hi: 0.2, lo: 0.34 });
  const yo = f ? 0 : 1;              // shoulders heave 1px
  px(g, 4, 7 + yo, 16, 13, c.mid);
  px(g, 4, 7 + yo, 16, 2, c.hi);
  px(g, 3, 9 + yo, 1, 8, c.mid); px(g, 20, 9 + yo, 1, 8, c.mid);
  px(g, 4, 16, 16, 4, c.lo);
  const h = ramp('#7c7264');
  px(g, 7, 3 + yo, 10, 4, h.mid); px(g, 7, 3 + yo, 10, 1, h.hi);
  // molten cracks brighten AND flare wider on frame 1
  const glow = f ? '#ffd070' : '#ff8a4c';
  px(g, 9, 11, 1, 5, glow); px(g, 13, 10, 1, 6, glow); px(g, 10, 14, 4, 1, glow);
  if (f) { px(g, 8, 12, 1, 3, '#ffb060'); px(g, 14, 12, 1, 3, '#ffb060'); px(g, 11, 16, 2, 1, '#ffb060'); }
  px(g, 8, 5 + yo, 2, 1, glow); px(g, 14, 5 + yo, 2, 1, glow);
  px(g, 4, 18, 4, 2, c.lo); px(g, 16, 18, 4, 2, c.lo);
}

function shade(g, f) {
  const c = ramp('#7d6bad');
  px(g, 7, 4, 10, 7, c.mid);
  px(g, 7, 4, 10, 2, c.hi);
  px(g, 6, 6, 1, 5, c.mid); px(g, 17, 6, 1, 5, c.mid);
  px(g, 7, 11, 10, 4, c.lo);
  g.fillStyle = c.lo; g.globalAlpha = 0.85;
  const w = f ? 0 : 1;
  g.fillRect(6, 15, 3, 3 - w); g.fillRect(11, 15, 2, 4); g.fillRect(15, 15, 3, 2 + w);
  g.globalAlpha = 0.45;
  g.fillRect(7, 18, 2, 2); g.fillRect(14, 18, 2, 2 + (f ? 1 : 0));
  g.globalAlpha = 1;
  px(g, 9, 7, 2, 2, '#c98bff'); px(g, 13, 7, 2, 2, '#c98bff');
  dot(g, 9, 7, '#e6ccff'); dot(g, 13, 7, '#e6ccff');
}

function spitter(g, f) {
  const c = ramp('#6fa64a');
  const bulge = f ? 1 : 0;
  px(g, 4 - bulge, 9, 16 + bulge * 2, 9, c.mid);
  px(g, 5, 8, 14, 2, c.hi);
  px(g, 4, 14, 16, 4, c.lo);
  const sac = f ? '#c8f27a' : '#b6e86a';
  px(g, 7, 11, 3, 3, sac); px(g, 14, 12, 3, 3, sac);
  dot(g, 7, 11, '#e8ffb0'); dot(g, 14, 12, '#e8ffb0');
  px(g, 7, 16, 10, 1, '#2e4a1c');
  px(g, 6, 6, 3, 3, c.mid); px(g, 15, 6, 3, 3, c.mid);
  px(g, 6, 6, 3, 1, c.hi); px(g, 15, 6, 3, 1, c.hi);
  dot(g, 7, 7, '#1a2810'); dot(g, 16, 7, '#1a2810');
}

function warden(g, f) {
  const c = ramp('#b8505f');
  const yo = f ? 0 : 1;
  px(g, 7, 6 + yo, 10, 12, c.mid);
  px(g, 7, 6 + yo, 10, 2, c.hi);
  px(g, 6, 9 + yo, 1, 7, c.lo); px(g, 17, 9 + yo, 1, 7, c.lo);
  px(g, 7, 15, 10, 3, c.lo);
  px(g, 7, 4 + yo, 10, 3, ramp('#7a2f3a').mid);
  px(g, 6, 2 + yo, 1, 3, '#d9d2be'); px(g, 17, 2 + yo, 1, 3, '#d9d2be');
  dot(g, 6, 1 + yo, '#efe8d2'); dot(g, 17, 1 + yo, '#efe8d2');
  // fiery sigil flares larger and brighter on frame 1
  const fire = f ? '#ffb85c' : '#ff7a3c';
  if (f) { px(g, 9, 9, 6, 6, fire); px(g, 8, 11, 8, 2, fire); dot(g, 11, 8, '#ffe0a0'); dot(g, 12, 8, '#ffe0a0'); }
  else { px(g, 10, 10, 4, 4, fire); px(g, 9, 11, 6, 2, fire); }
  px(g, 9, 6 + yo, 2, 1, '#ffe14a'); px(g, 13, 6 + yo, 2, 1, '#ffe14a');
}

function boss(g, f) {
  const robe = ramp('#3a2a3f', { hi: 0.3, lo: 0.4 });
  const sway = f ? 1 : 0;
  px(g, 11, 12, 15, 20, robe.mid);
  px(g, 11, 12, 15, 2, robe.hi);
  px(g, 10 - sway, 16, 1, 14, robe.lo); px(g, 26 + sway, 16, 1, 14, robe.lo);
  px(g, 11, 26, 15, 6, robe.lo);
  const hd = ramp('#4a3550');
  px(g, 13, 7, 11, 6, hd.mid); px(g, 13, 7, 11, 1, hd.hi);
  const gold = ramp('#e0b341');
  px(g, 13, 4, 11, 3, gold.mid); px(g, 13, 4, 11, 1, gold.hi);
  px(g, 13, 1, 2, 3, gold.mid); px(g, 18, 1, 2, 3, gold.mid); px(g, 22, 1, 2, 3, gold.mid);
  dot(g, 13, 1, gold.hi); dot(g, 18, 1, gold.hi); dot(g, 22, 1, gold.hi);
  px(g, 15, 9, 3, 2, '#ff5d6c'); px(g, 20, 9, 3, 2, '#ff5d6c');
  dot(g, 16, 9, '#ffb0b8'); dot(g, 21, 9, '#ffb0b8');
  const sig = f ? '#d8b0ff' : '#c98bff';
  px(g, 17, 18, 3, 6, sig); px(g, 15, 20, 7, 2, sig);
  px(g, 8, 13, 3, 3, gold.mid); px(g, 26, 13, 3, 3, gold.mid);
}

function hero(g, f) {
  const body = ramp('#e7e3d4', { hi: 0.2, lo: 0.24 });
  const cloak = ramp('#3a6f8f');
  const step = f ? 1 : 0;
  px(g, 9, 7, 6, 9, body.mid);
  px(g, 9, 7, 6, 2, body.hi);
  px(g, 9, 13, 6, 3, body.lo);
  px(g, 9, 4, 6, 4, ramp('#c9c3ac').mid);
  px(g, 10, 5, 4, 1, '#f0ead4');
  g.fillStyle = cloak.mid;
  g.fillRect(7, 8, 2, 8 - step); g.fillRect(15, 8, 2, 7 + step);
  g.fillRect(8, 15, 8, 2);
  dot(g, 7, 8, cloak.hi); dot(g, 16, 8, cloak.hi);
  px(g, 10, 16, 2, 3 + step, body.lo); px(g, 13, 16, 2, 4 - step, body.lo);
  px(g, 10, 6, 4, 2, '#2a2a2a'); dot(g, 11, 6, '#8fd1ff'); dot(g, 13, 6, '#8fd1ff');
}


function emberHero(g, f) {
  const robe = ramp('#5b2330', { hi: 0.32, lo: 0.36 });
  const flame = f ? '#ffd070' : '#ff8a4c';
  const step = f ? 1 : 0;
  px(g, 8, 8, 8, 9, robe.mid);
  px(g, 8, 8, 8, 2, robe.hi);
  px(g, 7, 10, 2, 7 - step, robe.lo); px(g, 15, 10, 2, 7 + step, robe.lo);
  px(g, 9, 16, 6, 3, robe.lo);
  px(g, 9, 4, 6, 5, '#e0b07a');
  px(g, 8, 2, 8, 3, '#ff7a3c');
  px(g, 10, 1, 2, 2, flame); px(g, 13, 1 + step, 2, 2, flame);
  px(g, 10, 6, 4, 2, '#2a120c'); dot(g, 11, 6, flame); dot(g, 13, 6, flame);
  px(g, 5, 11, 2, 2, flame); px(g, 17, 11, 2, 2, flame);
  dot(g, 5, 10, '#ffe0a0'); dot(g, 18, 10, '#ffe0a0');
}

function ironHero(g, f) {
  const steel = ramp('#7d8fa3', { hi: 0.35, lo: 0.38 });
  const trim = ramp('#d6b15f', { hi: 0.25, lo: 0.3 });
  const yo = f ? 0 : 1;
  px(g, 7, 7 + yo, 10, 10, steel.mid);
  px(g, 7, 7 + yo, 10, 2, steel.hi);
  px(g, 9, 3 + yo, 6, 5, steel.mid); px(g, 10, 2 + yo, 4, 1, steel.hi);
  px(g, 6, 9 + yo, 2, 7, trim.mid); px(g, 16, 9 + yo, 2, 7, trim.mid);
  px(g, 5, 11, 4, 6, '#5b6f86'); px(g, 4, 12, 1, 4, steel.hi);
  px(g, 10, 16, 2, 4, steel.lo); px(g, 14, 16, 2, 4, steel.lo);
  px(g, 10, 5 + yo, 4, 2, '#172232'); dot(g, 11, 5 + yo, '#8fd1ff'); dot(g, 13, 5 + yo, '#8fd1ff');
  px(g, 12, 9 + yo, 1, 7, trim.hi);
}

function shadeHero(g, f) {
  const cloth = ramp('#2b2545', { hi: 0.35, lo: 0.36 });
  const moon = f ? '#f2eaff' : '#c86bff';
  const step = f ? 1 : 0;
  px(g, 9, 6, 6, 11, cloth.mid);
  px(g, 8, 8, 8, 3, cloth.hi);
  px(g, 7, 11, 3, 6 + step, cloth.lo); px(g, 14, 11, 3, 6 - step, cloth.lo);
  px(g, 9, 3, 6, 5, '#181526'); px(g, 8, 5, 1, 3, '#181526'); px(g, 15, 5, 1, 3, '#181526');
  px(g, 10, 6, 4, 2, '#08070d'); dot(g, 11, 6, moon); dot(g, 13, 6, moon);
  px(g, 6, 14, 3, 1, moon); px(g, 15, 14, 3, 1, moon);
  px(g, 10, 17, 2, 3 + step, cloth.lo); px(g, 13, 17, 2, 4 - step, cloth.lo);
  dot(g, 12, 10, '#e6ccff');
}

// ---------- environment tiles ----------
function floorTile(variant) {
  return make(40, 40, (g) => {
    const base = ramp(variant % 2 ? '#1b2130' : '#1e2436', { hi: 0.08, lo: 0.14 });
    px(g, 0, 0, 40, 40, base.mid);
    g.fillStyle = base.hi; g.fillRect(0, 0, 40, 2); g.fillRect(0, 0, 2, 40);
    g.fillStyle = '#0f1320'; g.fillRect(0, 38, 40, 2); g.fillRect(38, 0, 2, 40);
    const spots = [[8,10],[26,6],[16,24],[32,30],[6,32],[22,16],[12,4],[34,14]];
    for (let i = 0; i < spots.length; i++) {
      const m = (variant + i) % 4;
      if (m === 0) px(g, spots[i][0], spots[i][1], 3, 3, base.lo);
      else if (m === 1) px(g, spots[i][0], spots[i][1], 2, 2, base.hi);
      else if (m === 2) dot(g, spots[i][0], spots[i][1], '#0f1320');
    }
    if (variant % 4 === 2) { px(g, 4, 28, 8, 6, '#2f4a3a'); px(g, 5, 28, 4, 2, '#3d6149'); px(g, 6, 30, 2, 1, '#4f7a5c'); }
    if (variant % 4 === 3) { px(g, 28, 6, 7, 6, '#2f4a3a'); px(g, 29, 6, 3, 2, '#3d6149'); }
  });
}

function wallTile() {
  return make(40, 40, (g) => {
    const s = ramp('#141a27', { hi: 0.5, lo: 0.4 });
    px(g, 0, 0, 40, 40, '#0b0f18');
    const bricks = [[0,6,18],[20,6,18],[0,18,26],[26,18,14],[0,32,12],[12,32,20]];
    for (const [bx, by, bw] of bricks) {
      px(g, bx + 1, by + 1, bw - 2, 10, s.mid);
      px(g, bx + 1, by + 1, bw - 2, 2, s.hi);
      px(g, bx + 1, by + 9, bw - 2, 2, s.lo);
    }
    px(g, 0, 0, 40, 3, '#2a3450'); px(g, 0, 3, 40, 1, '#1c2438');
  });
}

function stairsTile() {
  return make(40, 40, (g) => {
    px(g, 0, 0, 40, 40, '#0e1420');
    const steps = ['#1c2436', '#171e2d', '#121826', '#0d121d', '#080b12'];
    for (let i = 0; i < steps.length; i++) px(g, 4 + i * 2, 6 + i * 6, 32 - i * 4, 6, steps[i]);
    g.fillStyle = '#f0b341'; g.globalAlpha = 0.9;
    g.fillRect(4, 4, 32, 2); g.fillRect(4, 4, 2, 30); g.fillRect(34, 4, 2, 30);
    g.globalAlpha = 0.4; g.fillRect(6, 6, 28, 2);
    g.globalAlpha = 1;
  });
}

function entryTile() {
  return make(40, 40, (g) => {
    px(g, 0, 0, 40, 40, '#0e1420');
    g.strokeStyle = '#6fe3c4'; g.lineWidth = 2.5;
    g.beginPath(); g.arc(20, 24, 12, Math.PI, 0); g.stroke();
    g.fillStyle = 'rgba(111,227,196,.14)'; g.fillRect(9, 24, 22, 14);
    g.fillStyle = 'rgba(111,227,196,.3)'; g.fillRect(9, 24, 22, 2);
  });
}

function goldCoin(g) {
  const c = ramp('#f0b341');
  g.fillStyle = c.mid; g.beginPath(); g.arc(7, 7, 5, 0, 7); g.fill();
  g.fillStyle = c.hi; g.beginPath(); g.arc(5.5, 5.5, 2.5, 0, 7); g.fill();
  g.fillStyle = c.lo; g.fillRect(5, 6, 4, 3);
  g.fillStyle = '#fff2c8'; g.fillRect(5, 4, 2, 1);
}
function hpOrb(g) {
  const c = ramp('#ff5d6c');
  g.fillStyle = c.mid; g.beginPath(); g.arc(7, 7, 5, 0, 7); g.fill();
  g.fillStyle = c.hi; g.beginPath(); g.arc(5.5, 5.5, 2, 0, 7); g.fill();
  g.fillStyle = '#fff'; g.globalAlpha = .8; g.fillRect(5, 4, 2, 1); g.globalAlpha = 1;
}

// ---------- build ----------
const CREATURE = { grub, skitter, brute, shade, spitter, warden };

function renderCreature(painter, frame, GRID, DISP) {
  const small = make(GRID, GRID, (g) => {
    painter(g, frame);
    outline(g, GRID, GRID, OUT);
    ambientOcclusion(g, GRID, GRID);
  });
  return make(DISP, DISP, (g) => {
    g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, DISP, DISP);
  });
}

export function buildSprites() {
  cache.floor = [0, 1, 2, 3].map((v) => floorTile(v));
  cache.wall = wallTile();
  cache.stairs = stairsTile();
  cache.entry = entryTile();

  const GRID = 24, DISP = 36;
  cache.mob = {};
  for (const [key, painter] of Object.entries(CREATURE)) {
    cache.mob[key] = { frames: [renderCreature(painter, 0, GRID, DISP), renderCreature(painter, 1, GRID, DISP)] };
  }
  cache.mob.boss = { frames: [renderCreature(boss, 0, 36, 54), renderCreature(boss, 1, 36, 54)] };
  cache.hero = {
    wanderer: { frames: [renderCreature(hero, 0, GRID, DISP), renderCreature(hero, 1, GRID, DISP)] },
    ember: { frames: [renderCreature(emberHero, 0, GRID, DISP), renderCreature(emberHero, 1, GRID, DISP)] },
    iron: { frames: [renderCreature(ironHero, 0, GRID, DISP), renderCreature(ironHero, 1, GRID, DISP)] },
    shade: { frames: [renderCreature(shadeHero, 0, GRID, DISP), renderCreature(shadeHero, 1, GRID, DISP)] },
  };
  cache.hero.frames = cache.hero.wanderer.frames;

  cache.gold = make(14, 14, (g) => goldCoin(g));
  cache.hp = make(14, 14, (g) => hpOrb(g));
  return cache;
}

export function sprites() { return cache; }

// Pick the animation frame for a sprite object; phase-shifts so creatures don't
// bob in unison. Returns a canvas.
export function frameFor(sprObj, phase = 0) {
  if (!sprObj) return null;
  if (!sprObj.frames) return sprObj;
  const i = Math.floor((Date.now() / 320 + phase)) & 1;
  return sprObj.frames[i];
}
