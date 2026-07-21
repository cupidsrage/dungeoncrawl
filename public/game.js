import {
  makeRNG, hashSeed, subSeed, generateDungeon, generateMonsters, generateItem,
  starterWeapon, starterWeaponAtTier, MAP_W, MAP_H, T, STATUS, ESSENCE_TIERS, ESSENCE_YIELD, ESSENCE_COLOR,
} from './gen.js?v=6';
import { buildSprites, sprites, frameFor } from './sprites.js?v=5';
import { UPGRADES, UPGRADE_CATEGORIES, availableCharacters, characterById, computeUpgradeEffects, nextCost } from './upgrades.js?v=6';

// ---------- high-definition art ----------
// Every actor has a dedicated eight-pose movement sheet. Each sheet was made
// from one definitive identity reference, so animation never swaps characters.
// The original atlas and procedural sprites remain zero-network fallbacks.
function loadArt(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return img;
}
const HD = {
  characters: loadArt('./assets/hd/character-atlas.png'),
  environment: loadArt('./assets/hd/environment-atlas.png'),
  icons: loadArt('./assets/hd/icon-atlas.png'),
};
const HD_VFX = {
  phys: loadArt('./assets/hd/vfx/phys.webp'),
  fire: loadArt('./assets/hd/vfx/fire.webp'),
  cold: loadArt('./assets/hd/vfx/cold.webp'),
  lightning: loadArt('./assets/hd/vfx/lightning.webp'),
  void: loadArt('./assets/hd/vfx/void.webp'),
  poison: loadArt('./assets/hd/vfx/poison.webp'),
};
const HD_HERO_WALK = {
  wanderer: loadArt('./assets/hd/animations/wanderer-walk.webp'),
  ember: loadArt('./assets/hd/animations/ember-walk.webp'),
  iron: loadArt('./assets/hd/animations/iron-walk.webp'),
  shade: loadArt('./assets/hd/animations/shade-hero-walk.webp'),
};
const HD_MOB_WALK = {
  grub: loadArt('./assets/hd/animations/grub-walk.webp'),
  skitter: loadArt('./assets/hd/animations/skitter-walk.webp'),
  brute: loadArt('./assets/hd/animations/brute-walk.webp'),
  shade: loadArt('./assets/hd/animations/shade-mob-walk.webp'),
  spitter: loadArt('./assets/hd/animations/spitter-walk.webp'),
  warden: loadArt('./assets/hd/animations/warden-walk.webp'),
  boss: loadArt('./assets/hd/animations/boss-walk.webp'),
  leech: loadArt('./assets/hd/animations/leech-walk.webp'),
  sentinel: loadArt('./assets/hd/animations/sentinel-walk.webp'),
  cultist: loadArt('./assets/hd/animations/cultist-walk.webp'),
  mimic: loadArt('./assets/hd/animations/mimic-walk.webp'),
};
const HD_HERO_COL = { wanderer:0, ember:1, iron:2, shade:3 };
const HD_MOB_CELL = { grub:[0,1], skitter:[1,1], brute:[2,1], shade:[3,1], spitter:[0,2], warden:[1,2], boss:[2,2] };
const HD_MOB_SIZE = {
  grub:[40,32], skitter:[42,34], brute:[48,46], shade:[38,44],
  spitter:[42,38], warden:[44,48], boss:[66,66],
  leech:[42,34], sentinel:[46,48], cultist:[42,48], mimic:[48,40],
};
const HD_MOB_FRAME_MS = {
  grub:115, skitter:82, brute:145, shade:125, spitter:138, warden:140, boss:165,
  leech:92, sentinel:128, cultist:120, mimic:105,
};
const HD_TREASURE_CELL = [3,2];
const HD_ABILITY_CELL = {
  bolt:[0,0], nova:[1,0], cleave:[2,0], lance:[3,0], volley:[4,0], chain:[5,0],
  meteor:[1,1], vortex:[4,1], orbit:[2,1], beam:[3,1], mine:[0,1],
};
const HD_ITEM_COL = {
  dagger:0, sword:1, axe:2, staff:3, bow:4, hammer:2, spear:3, scythe:2, wand:3, crossbow:4,
  robe:5, leather:5, plate:5, chainmail:5, brigandine:5, mantle:5, boneguard:5,
  ring:5, amulet:5, charm:5, sigil:5, tome:5, idol:5, lantern:5,
};

function artReady(img) { return !!img && img.complete && img.naturalWidth > 0; }
function drawArtCell(img, col, row, cols, rows, dx, dy, dw, dh, flip = false, alpha = 1) {
  if (!artReady(img)) return false;
  // Generated atlases are not always evenly divisible by their grid dimensions.
  // Rounded cell edges prevent bilinear sampling from bleeding an adjacent frame
  // into the current sprite (the visible "two halves" animation artifact).
  const sx = Math.round(col * img.naturalWidth / cols);
  const sy = Math.round(row * img.naturalHeight / rows);
  const sw = Math.round((col + 1) * img.naturalWidth / cols) - sx;
  const sh = Math.round((row + 1) * img.naturalHeight / rows) - sy;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha *= alpha;
  if (flip) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  } else {
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  ctx.restore();
  return true;
}

function movementCell(now, frameMs, phase = 0) {
  const frame = Math.floor((now + phase) / frameMs) % 8;
  return [frame % 4, Math.floor(frame / 4)];
}

function drawCenteredArtCell(img, col, row, cols, rows, cx, cy, dw, dh, flip = false, alpha = 1) {
  return drawArtCell(img, col, row, cols, rows, cx - dw / 2, cy - dh / 2, dw, dh, flip, alpha);
}

function effectFrame(time, start = 0, count = 8, frameMs = 70) {
  return start + (Math.floor(time / frameMs) % count);
}

function drawVfx(dtype, frame, cx, cy, size, rotation = 0, alpha = 1) {
  const img = HD_VFX[dtype] || HD_VFX.phys;
  if (!artReady(img)) return false;
  const index = Math.max(0, Math.min(7, frame | 0));
  const col = index % 4, row = Math.floor(index / 4);
  const sx = col * img.naturalWidth / 4, sy = row * img.naturalHeight / 2;
  const sw = img.naturalWidth / 4, sh = img.naturalHeight / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.globalAlpha *= alpha;
  ctx.globalCompositeOperation = 'screen';
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, -size / 2, -size / 2, size, size);
  ctx.restore();
  return true;
}

function atlasPosition(col, row, cols, rows) {
  const x = cols === 1 ? 0 : col / (cols - 1) * 100;
  const y = rows === 1 ? 0 : row / (rows - 1) * 100;
  return `${x}% ${y}%`;
}

// Build sprites up front. Wrapped so that if anything in the art pipeline throws
// in a given browser, the game still boots (buttons still work) with fallback art.
let SPR;
try {
  SPR = buildSprites();
} catch (err) {
  console.error('Sprite build failed, using fallback shapes:', err);
  SPR = makeFallbackSprites();
}

// Minimal solid-color canvases so draw() has something to blit if the real art
// pipeline ever fails. Keeps the game fully playable, just less pretty.
function makeFallbackSprites() {
  const solid = (w, h, color) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h);
    return c;
  };
  const mob = (color, boss) => ({ frames: [solid(boss ? 54 : 36, boss ? 54 : 36, color), solid(boss ? 54 : 36, boss ? 54 : 36, color)] });
  return {
    floor: ['#1c2130', '#20263a', '#1c2130', '#20263a'].map((c) => solid(20, 20, c)),
    wall: solid(20, 20, '#0d1119'),
    stairs: solid(20, 20, '#f0b341'),
    entry: solid(20, 20, '#6fe3c4'),
    mob: {
      grub: mob('#8fae6b'), skitter: mob('#caa24b'), brute: mob('#8a8073'),
      shade: mob('#7d6bad'), spitter: mob('#6fa64a'), warden: mob('#b8505f'), boss: mob('#e0b341', true),
    },
    hero: {
      wanderer: { frames: [solid(36, 36, '#e7e3d4'), solid(36, 36, '#e7e3d4')] },
      ember: { frames: [solid(36, 36, '#ff8a5c'), solid(36, 36, '#ff8a5c')] },
      iron: { frames: [solid(36, 36, '#8fd1ff'), solid(36, 36, '#8fd1ff')] },
      shade: { frames: [solid(36, 36, '#c86bff'), solid(36, 36, '#c86bff')] },
      frames: [solid(36, 36, '#e7e3d4'), solid(36, 36, '#e7e3d4')],
    },
    gold: solid(14, 14, '#f0b341'), hp: solid(14, 14, '#ff5d6c'),
  };
}

// ---------- ACCOUNT / AUTH ----------
// Token lives in localStorage; essence balance is owned by the server. All calls
// that mutate essence go through the server so it stays authoritative (important
// once multiplayer lands).
const Account = {
  token: localStorage.getItem('seedspire_token') || null,
  username: null,
  essence: null,
  upgrades: null,
  selectedCharacter: localStorage.getItem('seedspire_character') || 'wanderer',
  get authed() { return !!this.token; },
  headers() { return this.token ? { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }; },
  set(token, account) {
    this.token = token; this.username = account.username; this.essence = account.essence; this.upgrades = account.upgrades || {};
    localStorage.setItem('seedspire_token', token);
  },
  clear() { this.token = null; this.username = null; this.essence = null; this.upgrades = null; localStorage.removeItem('seedspire_token'); },
  // Merged effect bag from all purchased upgrades (applied to a new run).
  effects() { return computeUpgradeEffects(this.upgrades || {}); },
  setCharacter(id) {
    const owned = availableCharacters(this.upgrades || {}).some((c) => c.id === id);
    this.selectedCharacter = owned ? id : 'wanderer';
    localStorage.setItem('seedspire_character', this.selectedCharacter);
  },
};

async function apiRegister(username, password) {
  const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Register failed');
  Account.set(data.token, data.account);
  return data.account;
}
async function apiLogin(username, password) {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Login failed');
  Account.set(data.token, data.account);
  return data.account;
}
async function apiMe() {
  if (!Account.token) return null;
  const r = await fetch('/api/me', { headers: Account.headers() });
  if (!r.ok) { Account.clear(); return null; }
  const data = await r.json();
  Account.username = data.account.username; Account.essence = data.account.essence; Account.upgrades = data.account.upgrades || {};
  return data.account;
}
async function apiLogout() {
  if (Account.token) { try { await fetch('/api/logout', { method: 'POST', headers: Account.headers() }); } catch {} }
  Account.clear();
}
// Bank a run's collected essence. keepFraction 1.0 = clean extract, 0.3 = death.
async function apiBankEssence(amounts, keepFraction) {
  if (!Account.token) return null;
  const r = await fetch('/api/essence/bank', { method: 'POST', headers: Account.headers(), body: JSON.stringify({ amounts, keepFraction }) });
  if (!r.ok) return null;
  const data = await r.json();
  Account.essence = data.essence;
  return data;   // { essence, gained }
}
// Buy the next level of an upgrade. Server validates & deducts; returns new state.
async function apiBuyUpgrade(id) {
  const r = await fetch('/api/upgrade/buy', { method: 'POST', headers: Account.headers(), body: JSON.stringify({ id }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Purchase failed');
  Account.essence = data.essence; Account.upgrades = data.upgrades;
  return data;
}

// ---------- STATUS ENGINE ----------
// Any entity (player or monster) carries `.fx_status = {}` — a map of
// statusKey -> { t: remaining, mag: magnitude, stacks: n }. These helpers
// apply, tick, and query effects uniformly for both sides.
function applyStatus(ent, key, dur, mag = 1) {
  const def = STATUS[key];
  if (!def) return;
  ent.fx_status = ent.fx_status || {};
  const cur = ent.fx_status[key];
  if (cur && def.stacks) { cur.t = Math.max(cur.t, dur); cur.stacks = Math.min(5, (cur.stacks || 1) + 1); cur.mag = mag; }
  else if (cur) { cur.t = Math.max(cur.t, dur); cur.mag = Math.max(cur.mag, mag); }
  else ent.fx_status[key] = { t: dur, mag, stacks: 1 };

  // chill building to freeze: enough chill stacks locks the target down
  if (key === 'chill') {
    const c = ent.fx_status.chill;
    if (c.stacks >= (def.buildsTo && 3)) { applyStatus(ent, 'freeze', 1.2); delete ent.fx_status.chill; }
  }
}
function hasStatus(ent, key) { return ent.fx_status && ent.fx_status[key] && ent.fx_status[key].t > 0; }
function isRooted(ent) { // can't move
  if (!ent.fx_status) return false;
  return Object.keys(ent.fx_status).some((k) => ent.fx_status[k].t > 0 && STATUS[k].root);
}
function isSilenced(ent) { // can't act/attack
  if (!ent.fx_status) return false;
  return Object.keys(ent.fx_status).some((k) => ent.fx_status[k].t > 0 && STATUS[k].silence);
}
// Aggregate a multiplicative modifier across active statuses (moveMul, dmgDealtMul, dmgTakenMul).
function statusMul(ent, field) {
  if (!ent.fx_status) return 1;
  let m = 1;
  for (const k in ent.fx_status) {
    if (ent.fx_status[k].t > 0 && STATUS[k][field] != null) m *= STATUS[k][field];
  }
  return m;
}
// Tick all statuses on an entity: countdown, DoT, heal. `onDot` gets (dmg) so
// player and monster can route damage through their own paths.
function tickStatus(ent, dt, onDot, onHeal) {
  if (!ent.fx_status) return;
  for (const k in ent.fx_status) {
    const st = ent.fx_status[k], def = STATUS[k];
    st.t -= dt;
    if (st.t <= 0) { delete ent.fx_status[k]; continue; }
    if (def.dot) { st.tick = (st.tick || 0) - dt; if (st.tick <= 0) { onDot(Math.max(1, def.dot * st.mag * (st.stacks || 1)), def.color); st.tick = 0.5; } }
    if (def.heal) { st.tick = (st.tick || 0) - dt; if (st.tick <= 0) { onHeal(def.heal * st.mag); st.tick = 0.5; } }
  }
}
function activeStatusList(ent) {
  if (!ent.fx_status) return [];
  return Object.keys(ent.fx_status).filter((k) => ent.fx_status[k].t > 0).map((k) => ({ key: k, ...STATUS[k], ...ent.fx_status[k] }));
}

// ---------- constants ----------
const TILE = 20;              // world units per tile
const VIEW_TILES_X = 30, VIEW_TILES_Y = 20;
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const DEVICE_DPR = Math.min(window.devicePixelRatio || 1, 2);

// ---------- game state ----------
let G = null; // whole run state
const keys = {};
let mouse = { x: 0, y: 0, down: false, right: false };

// ---------- audio ----------
// Procedural Web Audio keeps the game self-contained: no downloaded assets, just
// a gloomy looping dungeon bed plus punchy one-shot sound effects. Browsers only
// allow audio after a user gesture, so start/resume is called from input handlers.
const Audio = (() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return { enabled: false, ensure() {}, toggle() {}, sfx() {}, setDanger() {}, updateButton() {} };
  let ctx, master, musicGain, sfxGain, loopTimer = null, step = 0, danger = 0;
  const KEY = 'seedspire_audio_muted';
  const state = { enabled: localStorage.getItem(KEY) !== '1' };
  const scale = [0, 3, 5, 7, 10, 12, 15, 17];

  function ensure() {
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain(); musicGain = ctx.createGain(); sfxGain = ctx.createGain();
      master.gain.value = state.enabled ? 0.55 : 0;
      musicGain.gain.value = 0.22; sfxGain.gain.value = 0.45;
      musicGain.connect(master); sfxGain.connect(master); master.connect(ctx.destination);
      startMusic();
    }
    if (ctx.state === 'suspended') ctx.resume();
    updateButton();
  }
  function updateButton() {
    const btn = document.getElementById('audioToggle');
    if (btn) btn.textContent = state.enabled ? '🔊 AUDIO' : '🔇 MUTED';
  }
  function toggle() {
    ensure(); state.enabled = !state.enabled; localStorage.setItem(KEY, state.enabled ? '0' : '1');
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.linearRampToValueAtTime(state.enabled ? 0.55 : 0, ctx.currentTime + 0.08);
    updateButton();
  }
  function tone(freq, dur, type = 'sine', gain = 0.15, dest = sfxGain, when = ctx?.currentTime || 0, slideTo = null) {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, when);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), when + dur);
    g.gain.setValueAtTime(0.0001, when); g.gain.exponentialRampToValueAtTime(gain, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(dest); o.start(when); o.stop(when + dur + 0.03);
  }
  function noise(dur, gain = 0.1, hp = 600, when = ctx?.currentTime || 0) {
    if (!ctx) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'highpass'; f.frequency.value = hp; g.gain.value = gain;
    src.buffer = b; src.connect(f); f.connect(g); g.connect(sfxGain); src.start(when);
  }
  function sfx(name) {
    ensure(); if (!state.enabled || !ctx) return;
    const now = ctx.currentTime;
    if (name === 'cast') { tone(220, .13, 'triangle', .13, sfxGain, now, 440); tone(660, .08, 'sine', .06, sfxGain, now + .03); }
    else if (name === 'hit') { noise(.08, .12, 900, now); tone(130, .09, 'square', .07, sfxGain, now, 90); }
    else if (name === 'hurt') { noise(.16, .15, 250, now); tone(180, .18, 'sawtooth', .08, sfxGain, now, 80); }
    else if (name === 'kill') { tone(330, .10, 'triangle', .12, sfxGain, now); tone(165, .22, 'sine', .10, sfxGain, now + .05, 82); }
    else if (name === 'pickup') { tone(660, .06, 'sine', .09, sfxGain, now); tone(990, .08, 'sine', .08, sfxGain, now + .06); }
    else if (name === 'loot') { tone(523, .08, 'triangle', .09, sfxGain, now); tone(784, .12, 'triangle', .09, sfxGain, now + .08); }
    else if (name === 'level') { [440,554,659,880].forEach((f,i)=>tone(f,.12,'triangle',.08,sfxGain,now+i*.07)); }
    else if (name === 'stairs') { tone(110, .35, 'sine', .12, sfxGain, now, 55); noise(.25, .08, 120, now); }
    else if (name === 'death') { tone(196, .7, 'sawtooth', .11, sfxGain, now, 49); noise(.55, .09, 80, now); }
  }
  function startMusic() {
    if (loopTimer) return;
    const playStep = () => {
      if (!ctx) return;
      const now = ctx.currentTime, root = 55 * (danger ? Math.pow(2, 2/12) : 1);
      if (step % 2 === 0) tone(root, 1.8, 'sine', .10, musicGain, now);
      const note = root * Math.pow(2, scale[(step * 3 + (danger ? 2 : 0)) % scale.length] / 12) * 2;
      if (step % 4 === 1) tone(note, .9, 'triangle', .035, musicGain, now + .15);
      if (danger && step % 4 === 3) tone(root * 4, .25, 'sawtooth', .025, musicGain, now + .05);
      step = (step + 1) % 16;
    };
    playStep(); loopTimer = setInterval(playStep, 750);
  }
  function setDanger(v) { danger = v ? 1 : 0; }
  window.addEventListener('pointerdown', ensure, { once: true });
  window.addEventListener('keydown', ensure, { once: true });
  return { get enabled() { return state.enabled; }, ensure, toggle, sfx, setDanger, updateButton };
})();


function resize() {
  const cw = VIEW_TILES_X * TILE, ch = VIEW_TILES_Y * TILE;
  // On narrow portrait screens, fill the height and let #game crop the wide
  // camera around its centered hero. Landscape and desktop retain full framing.
  const portraitCrop = window.innerWidth <= 560 && window.innerHeight > window.innerWidth;
  const scale = portraitCrop ? window.innerHeight / ch : Math.min(window.innerWidth / cw, window.innerHeight / ch);
  // Match the backing canvas to its displayed size. The old fixed 600x400
  // buffer was enlarged by CSS on most screens, which made detailed art look
  // translucent and grainy even when image smoothing was enabled.
  const renderScale = Math.min(DEVICE_DPR * scale, 3);
  cv.width = Math.round(cw * renderScale); cv.height = Math.round(ch * renderScale);
  cv.style.width = cw * scale + 'px';
  cv.style.height = ch * scale + 'px';
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener('resize', resize);

// ---------- character math ----------
function recomputeStats() {
  const p = G.player;
  const eq = Object.values(p.equip).filter(Boolean);
  const s = { maxHp: 100, armor: 0, critChance: 0.05, critDmg: 0.5, lifesteal: 0, moveSpeed: 0,
    dodge: 0, regen: 0.25, cdr: 0, flatDmg: 0, fireDmg: 0, coldDmg: 0, lightningDmg: 0, voidDmg: 0, poisonDmg: 0,
    attackSpeed: 0, abilityPower: 0, area: 0, projectileSpeed: 0, statusDur: 0, execute: 0,
    thorns: 0, blockChance: 0, pickupRadius: 0, goldFind: 0, luck: 0 };
  s.maxHp += (p.level - 1) * 10;
  for (const it of eq) for (const [k, v] of Object.entries(it.stats)) {
    if (s[k] != null && !['dmgLo', 'dmgHi', 'spd'].includes(k)) s[k] += v;
  }
  // Account upgrade effects (permanent, from the Vault of Power).
  const eff = G.upgradeEffects || computeUpgradeEffects({});
  s.maxHp += eff.maxHp || 0;
  s.armor += eff.armor || 0;
  s.critChance += eff.critChance || 0;
  s.cdr += eff.cdr || 0;
  s.moveSpeed += eff.moveSpeed || 0;
  const hero = characterById(p.characterId);
  const heroEff = hero.effects || {};
  s.maxHp += heroEff.maxHp || 0;
  s.armor += heroEff.armor || 0;
  s.critChance += heroEff.critChance || 0;
  s.cdr += heroEff.cdr || 0;
  s.moveSpeed += heroEff.moveSpeed || 0;
  s.fireDmgMul = heroEff.fireDmgMul || 1;
  s.dmgMul = eff.dmgMul || 1;          // applied to weapon+ability damage
  s.critChance = Math.min(.75, s.critChance);
  s.dodge = Math.min(.55, s.dodge);
  s.blockChance = Math.min(.5, s.blockChance);
  s.cdr = Math.min(.65, s.cdr);
  s.execute = Math.min(.25, s.execute);
  p.stats = s;
  p.maxHp = s.maxHp;
  if (p.hp > p.maxHp) p.hp = p.maxHp;
  // Abilities come from equipped weapon(s): main weapon + trinket-granted if any.
  p.abilities = [];
  if (p.equip.weapon?.ability) p.abilities.push({ ...p.equip.weapon.ability, cdLeft: 0, weapon: p.equip.weapon });
  if (p.equip.weapon2?.ability) p.abilities.push({ ...p.equip.weapon2.ability, cdLeft: 0, weapon: p.equip.weapon2 });
  // Defensive procs come from equipped armor + trinket.
  p.defenses = [];
  for (const slot of ['armor', 'trinket']) {
    const it = p.equip[slot];
    if (it?.defense) p.defenses.push({ ...it.defense, cdLeft: 0 });
  }
}

function weaponDamage() {
  const w = G.player.equip.weapon;
  const s = G.player.stats;
  let base = w ? (G.rng.int(w.stats.dmgLo, w.stats.dmgHi)) : G.rng.int(2, 4);
  base += s.flatDmg + (s.fireDmg * (s.fireDmgMul || 1)) + s.coldDmg + s.lightningDmg + s.voidDmg + s.poisonDmg;
  return base * (s.dmgMul || 1);   // Might upgrade multiplier
}

// ---------- run setup ----------
const FLOOR_MODIFIERS = [
  { key: 'fortified', name: 'FORTIFIED', desc: 'Enemies have 28% more life.', apply: (m) => { m.maxHp = Math.round(m.maxHp * 1.28); m.hp = m.maxHp; m.xp = Math.round(m.xp * 1.12); } },
  { key: 'hunting', name: 'HUNTING', desc: 'Enemies move and strike faster.', apply: (m) => { m.spd *= 1.18; m.dmg = Math.round(m.dmg * 1.1); m.xp = Math.round(m.xp * 1.12); } },
  { key: 'cursed', name: 'CURSED', desc: 'Enemies deal heavier damage but carry better loot.', apply: (m) => { m.dmg = Math.round(m.dmg * 1.2); m.dropBonus = .18; } },
  { key: 'gilded', name: 'GILDED', desc: 'More treasure and triple enemy shards.', apply: (m) => { m.dropBonus = .25; m.goldMul = 3; } },
];

function buildFloor(floor) {
  const d = generateDungeon(G.seed, floor);
  G.floor = floor;
  G.grid = d.grid;
  G.rooms = d.rooms;
  G.exit = d.exit;
  G.monsters = generateMonsters(G.seed, floor, d.rooms).map((m) => ({
    ...m, fx: m.x, fy: m.y, hitFlash: 0, aggro: false,
    atkCd: G.rng.float(0.2, 1.0), chargeState: 'idle', chargeT: 0, telegraph: 0, cvx: 0, cvy: 0, dodgeCd: 0,
    retreating: false, retreatT: 0, retreatCd: 0, telegraphKind: null,
    summonCd: G.rng.float(2.5, 5), summonCount: 0,
  }));
  const modifierRng = makeRNG(subSeed(G.seed, `floor-modifier:${floor}`));
  G.floorModifier = floor >= 2 && modifierRng.chance(.68) ? modifierRng.pick(FLOOR_MODIFIERS) : null;
  if (G.floorModifier) for (const m of G.monsters) G.floorModifier.apply(m);
  G.drops = [];       // ground loot {x,y,item}
  G.projectiles = [];   // player projectiles
  G.eproj = [];         // enemy projectiles
  G.novaRings = [];     // expanding nova ring pulses
  G.abilityZones = [];  // meteors, vortexes, and armed mines
  G.orbitals = [];      // orbiting player attacks
  G.effects = [];
  G.pickups = [];     // gold/hp orbs
  // Place player at entry.
  G.player.px = (d.entry.x + 0.5) * TILE;
  G.player.py = (d.entry.y + 0.5) * TILE;
  log(`You enter floor ${floor}.`, floor % 5 === 0 ? 'var(--danger)' : 'var(--dim)');
  if (G.floorModifier) log(`${G.floorModifier.name}: ${G.floorModifier.desc}`, 'var(--accent)');
  if (floor % 5 === 0) log('Something vast stirs below.', 'var(--danger)');
  Audio.setDanger(floor % 5 === 0);
  Audio.sfx('stairs');
}

function newRun(seed, name, startFloor = 1) {
  const numericSeed = hashSeed(seed);
  // Account upgrade effects for this run (empty bag if not logged in).
  const eff = Account.authed ? Account.effects() : computeUpgradeEffects({});
  // Starter weapon: upgraded to a guaranteed rarity if the player bought Armory.
  const ownedCharacters = eff.unlockedCharacters || ['wanderer'];
  const selectedCharacter = ownedCharacters.includes(Account.selectedCharacter) ? Account.selectedCharacter : 'wanderer';
  Account.setCharacter(selectedCharacter);
  const starter = eff.starterTier ? starterWeaponAtTier(seed, eff.starterTier) : starterWeapon(seed);
  G = {
    id: null, seed, name: name || 'Wanderer', upgradeEffects: eff,
    rng: makeRNG(numericSeed ^ 0x9e3779b9),
    floor: 1, floorsCleared: 0, gold: eff.startGold || 0, killCount: 0,
    runEssence: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },  // banked at extract/death
    player: {
      px: 0, py: 0, hp: 100, maxHp: 100, level: 1, xp: 0, xpNext: 20,
      characterId: selectedCharacter,
      dir: { x: 0, y: 1 }, dashCd: 0, invuln: 0, hitFlash: 0,
      equip: { weapon: starter, weapon2: null, armor: null, trinket: null },
      offhandUnlocked: !!eff.offhandUnlocked,
      bag: [], stats: {}, abilities: [],
    },
    grid: null, rooms: [], monsters: [], drops: [], projectiles: [], effects: [], pickups: [], abilityZones: [], orbitals: [],
    lastTime: 0, alive: true,
  };
  recomputeStats();
  G.player.hp = G.player.maxHp;
  buildFloor(startFloor);
  if (startFloor > 1) log(`Deep start — descending straight to floor ${startFloor}.`, 'var(--accent)');
  renderAbilityBar();
}

// ---------- persistence ----------
async function saveRun() {
  if (!G) return;
  const state = {
    floor: G.floor, gold: G.gold, killCount: G.killCount, floorsCleared: G.floorsCleared,
    player: {
      hp: G.player.hp, level: G.player.level, xp: G.player.xp, xpNext: G.player.xpNext,
      equip: G.player.equip, bag: G.player.bag, characterId: G.player.characterId,
    },
  };
  try {
    if (!G.id) {
      const r = await fetch('/api/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: G.seed }) });
      G.id = (await r.json()).id;
      localStorage.setItem('seedspire_last', JSON.stringify({ id: G.id, seed: G.seed, name: G.name }));
    }
    await fetch(`/api/save/${G.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: G.seed, state }) });
  } catch (e) { /* offline: run stays in memory */ }
}

async function loadRun() {
  const last = localStorage.getItem('seedspire_last');
  if (!last) { log('No saved run found.', 'var(--danger)'); return false; }
  const { id, seed, name } = JSON.parse(last);
  try {
    const r = await fetch(`/api/save/${id}`);
    if (!r.ok) throw 0;
    const { state } = await r.json();
    newRun(seed, name);
    G.id = id;
    Object.assign(G, { gold: state.gold, killCount: state.killCount, floorsCleared: state.floorsCleared });
    Object.assign(G.player, {
      level: state.player.level, xp: state.player.xp, xpNext: state.player.xpNext,
      equip: state.player.equip, bag: state.player.bag, characterId: state.player.characterId || 'wanderer',
    });
    recomputeStats();
    G.player.hp = state.player.hp;
    buildFloor(state.floor);
    renderAbilityBar();
    return true;
  } catch { log('Could not load run.', 'var(--danger)'); return false; }
}

// ---------- input ----------
// True when the user is typing into a text field — so game controls don't
// swallow keystrokes meant for the seed/name inputs.
function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
window.addEventListener('keydown', (e) => {
  if (isTyping()) return;               // let the input receive the key normally
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === 'i') { e.preventDefault(); toggleInv(); }
  if (k === 'm') { e.preventDefault(); Audio.toggle(); }
  if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','j','k',' '].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => { if (isTyping()) return; keys[e.key.toLowerCase()] = false; });
// When a text field gains focus, wipe any held-key state so movement doesn't
// stay "stuck on" after the player clicks back into the game.
document.addEventListener('focusin', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    for (const key in keys) keys[key] = false;
  }
});

cv.addEventListener('mousemove', (e) => {
  const r = cv.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) / r.width * (VIEW_TILES_X * TILE);
  mouse.y = (e.clientY - r.top) / r.height * (VIEW_TILES_Y * TILE);
  // keep button state in sync while moving (catches a release the window missed)
  mouse.down = (e.buttons & 1) !== 0;
  mouse.right = (e.buttons & 2) !== 0;
});
// Track left/right using the buttons bitmask (bit 0 = left, bit 1 = right),
// which is more reliable across mice than the single-button field.
cv.addEventListener('mousedown', (e) => {
  mouse.down = (e.buttons & 1) !== 0;
  mouse.right = (e.buttons & 2) !== 0;
  e.preventDefault();
});
// mouseup on window so a release outside the canvas still clears the button.
window.addEventListener('mouseup', (e) => {
  mouse.down = (e.buttons & 1) !== 0;
  mouse.right = (e.buttons & 2) !== 0;
});
// If the pointer leaves the window or loses focus, clear all buttons so nothing
// sticks "held" (a common cause of an attack firing on its own).
window.addEventListener('blur', () => { mouse.down = false; mouse.right = false; });
document.addEventListener('mouseleave', () => { mouse.down = false; mouse.right = false; });
// Suppress the right-click context menu ("Save image…") everywhere on the page,
// so it can never appear over the game regardless of which overlay was clicked.
window.addEventListener('contextmenu', (e) => { e.preventDefault(); return false; });

// touch controls
let touchVec = { x: 0, y: 0 }, stickId = null;
const stick = document.getElementById('stick'), nub = document.getElementById('nub'), fireBtn = document.getElementById('fire');
function handleStick(t) {
  const r = stick.getBoundingClientRect();
  let dx = t.clientX - (r.left + r.width / 2), dy = t.clientY - (r.top + r.height / 2);
  const mag = Math.hypot(dx, dy) || 1, max = 46;
  const cl = Math.min(mag, max);
  touchVec = { x: dx / mag, y: dy / mag };
  nub.style.transform = `translate(${(dx / mag) * cl}px,${(dy / mag) * cl}px)`;
}
stick.addEventListener('touchstart', (e) => { stickId = e.changedTouches[0].identifier; handleStick(e.changedTouches[0]); e.preventDefault(); });
window.addEventListener('touchmove', (e) => { for (const t of e.changedTouches) if (t.identifier === stickId) handleStick(t); }, { passive: false });
window.addEventListener('touchend', (e) => { for (const t of e.changedTouches) if (t.identifier === stickId) { stickId = null; touchVec = { x: 0, y: 0 }; nub.style.transform = ''; } });
let firing = false;
fireBtn.addEventListener('touchstart', (e) => { firing = true; e.preventDefault(); });
fireBtn.addEventListener('touchend', () => { firing = false; });

// ---------- collision ----------
function isWall(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  return G.grid[ty][tx] === T.WALL;
}
function canMove(px, py) {
  // A compact collision footprint keeps one-tile passages and inside corners
  // fluid while the larger painted silhouette can overlap them decoratively.
  const r = 4.5;
  for (const [ox, oy] of [[-r,-r],[r,-r],[-r,r],[r,r]]) {
    if (isWall(Math.floor((px + ox) / TILE), Math.floor((py + oy) / TILE))) return false;
  }
  return true;
}

// ---------- combat ----------
function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1, vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / len2));
  return Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t));
}

function damageRadius(x, y, radius, dmg, dtype, onHit) {
  for (const m of [...G.monsters]) {
    const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
    if (Math.hypot(mx - x, my - y) <= radius) damageMonster(m, dmg, dtype, onHit);
  }
}

function fireAbility(idx, tx, ty) {
  const p = G.player;
  const ab = p.abilities[idx];
  if (!ab || ab.cdLeft > 0) return;
  if (isSilenced(p)) return;                 // frozen/stunned can't cast
  const dx = tx - p.px, dy = ty - p.py;
  const ang = Math.atan2(dy, dx);
  const cd = ab.cd * Math.max(0.2, 1 - p.stats.cdr);
  ab.cdLeft = cd;
  const dmgBase = Math.round((ab.power * (p.stats.dmgMul || 1) * (1 + p.stats.abilityPower)) + Math.floor(weaponDamage() * 0.5));
  const areaMul = 1 + p.stats.area;
  const shotSpeed = 240 * (1 + p.stats.projectileSpeed);
  const onHit = ab.onHit ? { ...ab.onHit, dur: ab.onHit.dur * (1 + p.stats.statusDur) } : null;
  const reach = ab.range * TILE;
  const aimDist = Math.hypot(dx, dy) || 1;
  const targetDist = Math.min(reach, aimDist);
  const targetX = p.px + Math.cos(ang) * targetDist;
  const targetY = p.py + Math.sin(ang) * targetDist;
  const mk = (a) => ({
    x: p.px, y: p.py, vx: Math.cos(a) * shotSpeed, vy: Math.sin(a) * shotSpeed,
    life: reach / shotSpeed, color: ab.color, dmg: dmgBase, dtype: ab.dmgType,
    pierce: ab.pierce, chain: ab.chain, hitSet: new Set(),
    onHit, r: 5, phase: G.rng.int(0, 280), shape: ab.shape,
  });

  if (ab.aoe && ab.shape === 'nova') {
    // Solid expanding ring of force — not projectile balls. It sweeps outward and
    // damages every enemy the ring front passes over, once each.
    const maxR = Math.max(90, reach) * areaMul;
    G.novaRings = G.novaRings || [];
    G.novaRings.push({
      x: p.px, y: p.py, r: 6, maxR, speed: 320, dmg: dmgBase, dtype: ab.dmgType,
      color: ab.color, onHit, hitSet: new Set(),
    });
    G.effects.push({ type: 'vfxCast', x: p.px, y: p.py, dtype: ab.dmgType, size: 72 * areaMul, life: .55, t: 0, color: ab.color });
  } else if (ab.shape === 'cleave') {
    // Wide arc in front, with more reach than before.
    for (let i = -2; i <= 2; i++) {
      const a = ang + i * 0.24;
      G.projectiles.push(Object.assign(mk(a), { life: 0.34, vx: Math.cos(a) * shotSpeed, vy: Math.sin(a) * shotSpeed }));
    }
    G.effects.push({ type: 'arc', x: p.px, y: p.py, ang, dtype: ab.dmgType, life: .32, t: 0, color: ab.color });
  } else if (ab.shape === 'meteor') {
    G.abilityZones.push({ kind: 'meteor', x: targetX, y: targetY, t: 0, delay: .75, radius: 58 * areaMul,
      dmg: dmgBase, dtype: ab.dmgType, color: ab.color, onHit, done: false });
  } else if (ab.shape === 'vortex') {
    G.abilityZones.push({ kind: 'vortex', x: targetX, y: targetY, t: 0, life: ab.duration || 3.2,
      radius: 52 * areaMul, dmg: dmgBase, dtype: ab.dmgType, color: ab.color, onHit, tick: 0 });
  } else if (ab.shape === 'orbit') {
    for (let i = 0; i < 3; i++) G.orbitals.push({ angle: i * Math.PI * 2 / 3, radius: 34 * areaMul,
      t: 0, life: ab.duration || 4.2, dmg: dmgBase, dtype: ab.dmgType, color: ab.color, onHit, hitCd: new Map() });
  } else if (ab.shape === 'beam') {
    const x2 = p.px + Math.cos(ang) * reach, y2 = p.py + Math.sin(ang) * reach;
    for (const m of [...G.monsters]) {
      const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
      if (pointSegmentDistance(mx, my, p.px, p.py, x2, y2) <= 14 * areaMul) damageMonster(m, dmgBase, ab.dmgType, onHit);
    }
    G.effects.push({ type: 'beam', x: p.px, y: p.py, x2, y2, dtype: ab.dmgType, color: ab.color, life: .32, t: 0 });
  } else if (ab.shape === 'mine') {
    G.abilityZones.push({ kind: 'mine', x: targetX, y: targetY, t: 0, life: ab.duration || 8, armed: .5,
      radius: 52 * areaMul, dmg: dmgBase, dtype: ab.dmgType, color: ab.color, onHit, done: false });
  } else if (ab.multi > 1) {
    for (let i = 0; i < ab.multi; i++) { const a = ang + (i - (ab.multi - 1) / 2) * 0.16; G.projectiles.push(mk(a)); }
  } else {
    G.projectiles.push(mk(ang));
  }
  G.effects.push({ type: 'vfxCast', x: p.px, y: p.py, dtype: ab.dmgType, size: ab.aoe ? 48 : 34, life: .42, t: 0, color: ab.color });
  // self-buff on cast
  if (ab.selfBuff) { applyStatus(p, ab.selfBuff.status, ab.selfBuff.dur, 1); log(`${STATUS[ab.selfBuff.status].name}!`, STATUS[ab.selfBuff.status].color); }
  Audio.sfx('cast');
  screenShake(ab.aoe ? 4 : 2);
}

function meleeSwing() {
  const p = G.player;
  if (p.swingCd > 0) return;
  p.swingCd = (p.equip.weapon?.stats.spd ? 0.5 / p.equip.weapon.stats.spd : 0.5) / (1 + p.stats.attackSpeed);
  const reach = 34;
  const aim = Math.atan2(mouse.y - VIEW_TILES_Y * TILE / 2, mouse.x - VIEW_TILES_X * TILE / 2);
  const ux = Math.cos(aim), uy = Math.sin(aim);
  G.effects.push({ type: 'swing', x: p.px, y: p.py, ang: aim, life: .15, t: 0, color: '#fff' });
  for (const m of G.monsters) {
    const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
    const d = Math.hypot(mx - p.px, my - p.py);
    if (d < reach) {
      const dot = ((mx - p.px) * ux + (my - p.py) * uy) / (d || 1);
      if (dot > 0.3) damageMonster(m, weaponDamage(), 'phys');
    }
  }
}

function damageMonster(m, amount, dtype, onHit = null) {
  const p = G.player;
  if (m.eliteShield > 0) {
    m.eliteShield--;
    m.hitFlash = 0.15;
    G.effects.push({ type: 'vfxHit', x: m.fx * TILE + TILE / 2, y: m.fy * TILE + TILE / 2,
      dtype: 'cold', size: 42, life: .34, t: 0, color: '#67cbe8' });
    spawnDamageNumber(m.fx * TILE + TILE / 2, m.fy * TILE + TILE / 2, 'ward', false, 'text');
    Audio.sfx('hit');
    return;
  }
  let dmg = amount * statusMul(p, 'dmgDealtMul');      // player Weaken/Rage
  dmg *= statusMul(m, 'dmgTakenMul');                   // target Vulnerable/Fortify
  const crit = G.rng.chance(p.stats.critChance);
  if (crit) dmg = Math.round(dmg * (1.5 + p.stats.critDmg));
  dmg = Math.round(dmg);
  m.hp -= dmg;
  if (m.hp > 0 && p.stats.execute > 0 && m.hp / m.maxHp <= p.stats.execute) m.hp = 0;
  m.hitFlash = 0.15;
  m.aggro = true;
  if (p.stats.lifesteal > 0) { p.hp = Math.min(p.maxHp, p.hp + dmg * p.stats.lifesteal); }
  // apply a status the hit carries (from the ability's damage type)
  if (onHit && G.rng.chance(onHit.chance)) applyStatus(m, onHit.status, onHit.dur, 1);
  spawnDamageNumber(m.fx * TILE + TILE / 2, m.fy * TILE + TILE / 2, dmg, crit, dtype);
  Audio.sfx('hit');
  if (m.hp <= 0) killMonster(m);
}

function killMonster(m) {
  G.monsters = G.monsters.filter((x) => x !== m);
  G.killCount++;
  gainXp(m.xp);
  // loot roll
  const dropChance = m.boss || m.treasure ? 1 : Math.min(0.9, 0.35 + (m.elite ? 0.25 : 0) + (m.dropBonus || 0) + G.player.stats.luck);
  if (G.rng.chance(dropChance)) {
    const mf = (m.boss ? 1.5 : m.elite ? 0.8 : m.treasure ? 1.1 : 0.2) + (G.upgradeEffects?.magicFind || 0) + G.player.stats.luck;
    const item = generateItem(G.seed, `f${G.floor}_${m.id}_${G.killCount}`, G.floor, mf);
    G.drops.push({ x: m.fx, y: m.fy, item, fx: m.fx, fy: m.fy });
  }
  // gold + hp orbs (healing is scarcer now — you're meant to feel attrition)
  const gold = Math.round((G.rng.int(2, 6) + G.floor) * (1 + G.player.stats.goldFind) * (m.treasure ? 3 : 1) * (m.goldMul || 1));
  G.pickups.push({ x: m.fx, y: m.fy, type: 'gold', amt: gold });
  if (G.rng.chance(0.10)) G.pickups.push({ x: m.fx + 0.3, y: m.fy, type: 'hp', amt: 5 + Math.floor(G.floor * 0.4) });
  Audio.sfx('kill');
  if (m.elite === 'volatile') {
    const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
    G.effects.push({ type: 'vfxHit', x: mx, y: my, dtype: 'fire', size: 92, life: .5, t: 0, color: '#ff8b42' });
    if (Math.hypot(G.player.px - mx, G.player.py - my) < 70) damagePlayer(Math.round(m.dmg * 1.25));
    screenShake(8);
  }
  if (m.boss) { log(`${m.name} falls!`, 'var(--gold)'); screenShake(10); }
}

function damagePlayer(amount, incomingStatus = null, source = null) {
  const p = G.player;
  if (p.invuln > 0) return;
  if (G.rng.chance(p.stats.dodge)) { spawnDamageNumber(p.px, p.py, 'dodge', false, 'text'); return; }
  if (G.rng.chance(p.stats.blockChance)) { spawnDamageNumber(p.px, p.py, 'block', false, 'text'); p.invuln = 0.18; return; }
  // Shield buff absorbs one hit entirely.
  if (hasStatus(p, 'shield')) { delete p.fx_status.shield; spawnDamageNumber(p.px, p.py, 'block', false, 'text'); p.invuln = 0.3; return; }
  let dmg = amount * (100 / (100 + p.stats.armor));
  dmg *= statusMul(p, 'dmgTakenMul');                  // Fortify (down) / Vulnerable (up)
  p.hp -= dmg;
  if (source && p.stats.thorns > 0 && source.hp > 0) damageMonster(source, p.stats.thorns, 'phys');
  p.hitFlash = 0.2; p.invuln = 0.25;
  if (incomingStatus && G.rng.chance(incomingStatus.chance ?? 1)) applyStatus(p, incomingStatus.status, incomingStatus.dur, 1);
  // onHit defensive procs: taking damage can trigger a shield/fortify/regen buff.
  if (p.defenses) for (const df of p.defenses) {
    if (df.trigger === 'onHit' && df.cdLeft <= 0) {
      applyStatus(p, df.buff, df.dur, 1);
      df.cdLeft = df.cd;
      log(`${STATUS[df.buff].name}!`, df.color);
    }
  }
  Audio.sfx('hurt');
  screenShake(5);
  if (p.hp <= 0) gameOver();
}

function gainXp(amount) {
  const p = G.player;
  p.xp += amount;
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level++;
    p.xpNext = Math.round(p.xpNext * 1.35 + 10);
    recomputeStats();
    p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.2);   // small heal, not a reset
    log(`Level up! You are level ${p.level}.`, 'var(--accent)');
    G.effects.push({ type: 'levelup', x: p.px, y: p.py, life: .8, t: 0 });
    Audio.sfx('level');
  }
}

// Player base move speed is 100 u/s; MOB_SPD 90 means a spd-1.0 chaser nearly keeps
// pace — you can create space but can't freely outrun a straight-line pursuer.
const MOB_SPD = 90;
const PROJ_COLORS = { fire: '#ff7a3c', cold: '#63c6ff', void: '#b46bff', poison: '#8fd14b', lightning: '#ffe14a' };

// ---------- line of sight ----------
// Bresenham walk between two tiles; false if any wall blocks the line.
function tileLOS(x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let i = 0; i < 200; i++) {
    if (isWall(x, y)) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dy === 0 ? 0 : dx, y += sy; }
  }
  return true;
}
// World-space LOS between a monster and the player.
function hasLOS(mx, my, tx, ty) {
  return tileLOS(Math.floor(mx / TILE), Math.floor(my / TILE), Math.floor(tx / TILE), Math.floor(ty / TILE));
}

// ---------- flow-field pathfinding ----------
// Once per frame we BFS outward from the player's tile across all floor tiles,
// storing distance in G.flow. A monster reads the neighbor with the lowest
// distance to get a direction that routes AROUND walls — real navigation, shared
// cheaply by every monster instead of per-mob A*.
function rebuildFlowField() {
  const pt = { x: Math.floor(G.player.px / TILE), y: Math.floor(G.player.py / TILE) };
  const dist = new Int16Array(MAP_W * MAP_H).fill(-1);
  if (isWall(pt.x, pt.y)) { G.flow = null; return; }
  const q = [pt]; dist[pt.y * MAP_W + pt.x] = 0;
  let head = 0;
  while (head < q.length) {
    const c = q[head++];
    const d = dist[c.y * MAP_W + c.x];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = c.x + dx, ny = c.y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (isWall(nx, ny)) continue;
      const idx = ny * MAP_W + nx;
      if (dist[idx] !== -1) continue;
      dist[idx] = d + 1; q.push({ x: nx, y: ny });
    }
  }
  G.flow = dist;
}
// Direction (unit vector) a monster should travel to approach the player via the
// flow field. Falls back to straight-line if no field. Returns {x,y} or null.
function flowDir(mx, my) {
  if (!G.flow) return null;
  const tx = Math.floor(mx / TILE), ty = Math.floor(my / TILE);
  const here = G.flow[ty * MAP_W + tx];
  if (here < 0) return null;
  let best = here, bx = 0, by = 0;
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
    const nx = tx + dx, ny = ty + dy;
    if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
    if (isWall(nx, ny)) continue;
    const d = G.flow[ny * MAP_W + nx];
    if (d >= 0 && d < best) { best = d; bx = dx; by = dy; }
  }
  if (bx === 0 && by === 0) return null;
  const mag = Math.hypot(bx, by);
  return { x: bx / mag, y: by / mag };
}

// Move a monster along the flow field toward the player (pathing around walls).
// If it has clear LOS and is close, it beelines instead (smoother final approach).
function pathToPlayer(m, unitsPerSec, dt) {
  const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
  const straight = hasLOS(mx, my, G.player.px, G.player.py);
  let dir;
  if (straight) {
    const a = Math.atan2(G.player.py - my, G.player.px - mx);
    dir = { x: Math.cos(a), y: Math.sin(a) };
  } else {
    dir = flowDir(mx, my) || { x: 0, y: 0 };
  }
  applyMobVelocity(m, dir, unitsPerSec, dt);
}

// Move toward an arbitrary world point via flow field when blocked, else straight.
function pathToPoint(m, tx, ty, unitsPerSec, dt) {
  const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
  let dir;
  if (hasLOS(mx, my, tx, ty)) {
    const a = Math.atan2(ty - my, tx - mx);
    dir = { x: Math.cos(a), y: Math.sin(a) };
  } else {
    dir = flowDir(mx, my) || { x: 0, y: 0 };
  }
  applyMobVelocity(m, dir, unitsPerSec, dt);
}

// Shared velocity application with local separation so mobs don't stack, plus
// axis-separated wall sliding.
function applyMobVelocity(m, dir, unitsPerSec, dt) {
  let vx = dir.x, vy = dir.y;
  // separation: gently push away from nearby monsters so a pack spreads out
  const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
  let sepx = 0, sepy = 0;
  for (const o of G.monsters) {
    if (o === m) continue;
    const ox = o.fx * TILE + TILE / 2, oy = o.fy * TILE + TILE / 2;
    const d = Math.hypot(ox - mx, oy - my);
    if (d > 0 && d < 22) { sepx += (mx - ox) / d; sepy += (my - oy) / d; }
  }
  vx += sepx * 0.6; vy += sepy * 0.6;
  const mag = Math.hypot(vx, vy) || 1; vx /= mag; vy /= mag;
  const step = unitsPerSec * dt;
  const nx = mx + vx * step, ny = my + vy * step;
  if (!isWall(Math.floor(nx / TILE), Math.floor(my / TILE))) m.fx = (nx - TILE / 2) / TILE;
  const cx = m.fx * TILE + TILE / 2;
  if (!isWall(Math.floor(cx / TILE), Math.floor(ny / TILE))) m.fy = (ny - TILE / 2) / TILE;
}

// Slide a monster toward a target point (or away, if sign = -1). Axis-separated so
// they hug walls instead of sticking. Returns true if it moved appreciably.
function moveMob(m, tx, ty, unitsPerSec, dt, sign = 1) {
  const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
  const ang = Math.atan2((ty - my) * sign, (tx - mx) * sign);
  const step = unitsPerSec * dt;
  const nx = mx + Math.cos(ang) * step, ny = my + Math.sin(ang) * step;
  let moved = false;
  if (!isWall(Math.floor(nx / TILE), Math.floor(my / TILE))) { m.fx = (nx - TILE / 2) / TILE; moved = true; }
  const cx = m.fx * TILE + TILE / 2;
  if (!isWall(Math.floor(cx / TILE), Math.floor(ny / TILE))) { m.fy = (ny - TILE / 2) / TILE; moved = true; }
  return moved;
}

// A flank offset point: each mob claims an angle around the player and aims for a
// spot on that ring, so a group surrounds instead of clumping head-on.
function flankPoint(m, radius) {
  const ang = m.flankAngle ?? (m.flankAngle = Math.random() * Math.PI * 2);
  return { x: G.player.px + Math.cos(ang) * radius, y: G.player.py + Math.sin(ang) * radius };
}

// Distribute all aggroed melee mobs evenly around the player so they encircle
// rather than pile onto one side. Ranged keep their own spacing logic.
function assignFlankSlots() {
  const melee = G.monsters.filter((m) => m.aggro && !m.boss && (m.behavior === 'chaser' || m.behavior === undefined || m.behavior === 'charger'));
  if (!melee.length) return;
  // sort by current angle so slots are assigned smoothly, then spread evenly
  melee.forEach((m) => {
    const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
    m._ang = Math.atan2(my - G.player.py, mx - G.player.px);
  });
  melee.sort((a, b) => a._ang - b._ang);
  const n = melee.length;
  melee.forEach((m, i) => { m.flankAngle = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.3; });
}

// Enemy fires a projectile (or spread) at the player.
// Find the retreat direction with the most open space ahead — so a mob backs into
// a room instead of a corner. Samples 8 directions biased away from the player,
// scoring each by how far it can travel before hitting a wall.
function bestRetreatDir(mx, my) {
  const px = G.player.px, py = G.player.py;
  const away = Math.atan2(my - py, mx - px);   // straight away from player
  let bestScore = -1, bestAng = away;
  for (let i = 0; i < 8; i++) {
    const ang = away + (i - 3.5) * 0.45;        // fan of directions around "away"
    let clear = 0;
    for (let d = TILE; d <= TILE * 6; d += TILE) {
      const tx = Math.floor((mx + Math.cos(ang) * d) / TILE);
      const ty = Math.floor((my + Math.sin(ang) * d) / TILE);
      if (isWall(tx, ty)) break;
      clear = d;
    }
    // prefer directions that are both open AND roughly away from the player
    const awayBias = Math.cos(ang - away) * TILE;   // bonus for pointing away
    const score = clear + awayBias;
    if (score > bestScore) { bestScore = score; bestAng = ang; }
  }
  return bestAng;
}

// True when the player is attacking AND roughly aiming at this monster — its cue
// to sidestep. Uses the aim vector (mouse) vs. direction to the monster.
function playerAimingAt(mx, my) {
  if (!(mouse.down || mouse.right || keys['j'] || keys['l'])) return false;
  const aimX = mouse.x - VIEW_TILES_X * TILE / 2 + G.player.px;
  const aimY = mouse.y - VIEW_TILES_Y * TILE / 2 + G.player.py;
  const aimAng = Math.atan2(aimY - G.player.py, aimX - G.player.px);
  const toMobAng = Math.atan2(my - G.player.py, mx - G.player.px);
  let diff = Math.abs(aimAng - toMobAng);
  if (diff > Math.PI) diff = Math.PI * 2 - diff;
  return diff < 0.5;   // within ~28° of the aim line
}

// Sidestep perpendicular to the player's aim, to juke an incoming attack.
function dodgeStep(m, spd, dt) {
  const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
  const toPlayer = Math.atan2(G.player.py - my, G.player.px - mx);
  const side = (m.dodgeDir || (m.dodgeDir = Math.random() < 0.5 ? 1 : -1));
  const perp = toPlayer + side * Math.PI / 2;
  const tx = mx + Math.cos(perp) * TILE * 2, ty = my + Math.sin(perp) * TILE * 2;
  // if that side is walled, flip
  if (isWall(Math.floor(tx / TILE), Math.floor(ty / TILE))) m.dodgeDir = -side;
  moveMob(m, mx + Math.cos(toPlayer + m.dodgeDir * Math.PI / 2) * TILE * 2,
             my + Math.sin(toPlayer + m.dodgeDir * Math.PI / 2) * TILE * 2, spd * 1.3, dt);
}

// Map each enemy projectile element to the debuff it inflicts on the player.
const PROJ_STATUS = {
  fire: { status: 'burn', chance: 1, dur: 2.5 },
  void: { status: 'weaken', chance: 0.6, dur: 3 },
  poison: { status: 'poison', chance: 1, dur: 3 },
  cold: { status: 'chill', chance: 1, dur: 1.8 },
  lightning: { status: 'stun', chance: 0.25, dur: 0.6 },
};
function enemyShoot(m, mx, my, opts = {}) {
  const p = G.player;
  const baseAng = Math.atan2(p.py - my, p.px - mx);
  const spread = opts.spread || 0, count = opts.count || 1, speed = opts.speed || 150;
  const color = opts.color || PROJ_COLORS[m.proj] || '#ff7a3c';
  for (let i = 0; i < count; i++) {
    const a = baseAng + (count > 1 ? (i - (count - 1) / 2) * spread : 0);
    G.eproj.push({
      x: mx, y: my, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      life: opts.life || 2.2, dmg: Math.round(m.dmg * (opts.dmgMul || 1.0)),
      color, ptype: m.proj, r: opts.r || 5, arc: opts.arc || false,
      onHit: opts.onHit || PROJ_STATUS[m.proj] || null,
      owner: m,
    });
  }
  G.effects.push({ type: 'vfxCast', x: mx, y: my, dtype: m.proj || 'phys', size: 34, life: .32, t: 0, color });
}

function spawnSummon(parent) {
  if (G.monsters.length >= 44 || parent.summonCount >= 3) return;
  const key = G.floor >= 5 && G.rng.chance(.35) ? 'leech' : 'grub';
  const offsets = [[1,0],[-1,0],[0,1],[0,-1]];
  const off = G.rng.pick(offsets);
  const fx = parent.fx + off[0], fy = parent.fy + off[1];
  if (isWall(Math.floor(fx), Math.floor(fy))) return;
  const maxHp = Math.round(20 + parent.level * 7);
  G.summonSerial = (G.summonSerial || 0) + 1;
  G.monsters.push({
    id: `summon_${G.floor}_${G.summonSerial}`, key, name: key === 'leech' ? 'Summoned Blood Leech' : 'Bonebound Grub',
    color: key === 'leech' ? '#cf4d56' : '#8fae6b', glyph: key === 'leech' ? 'L' : 'g', fx, fy, x: fx, y: fy,
    hp: maxHp, maxHp, dmg: Math.round(4 + parent.level * 2.2), spd: key === 'leech' ? 1.3 : 1.05,
    level: parent.level, xp: Math.round(2 + parent.level), behavior: key === 'leech' ? 'leech' : 'chaser',
    proj: null, special: null, hitFlash: 0, aggro: true, atkCd: .4, chargeState: 'idle', chargeT: 0,
    telegraph: 0, cvx: 0, cvy: 0, dodgeCd: 0, retreating: false, retreatT: 0, retreatCd: 0,
  });
  parent.summonCount++;
  G.effects.push({ type: 'vfxCast', x: fx * TILE + TILE / 2, y: fy * TILE + TILE / 2,
    dtype: 'void', size: 54, life: .55, t: 0, color: '#9c6ed0' });
}

// ---------- monster AI ----------
function updateMonsters(dt) {
  const p = G.player;
  rebuildFlowField();   // one shared BFS from the player; all mobs path off it
  // periodic flank reassignment so the group re-spaces as you move
  G.flankTick = (G.flankTick || 0) - dt;
  if (G.flankTick <= 0) { assignFlankSlots(); G.flankTick = 1.5; }

  for (const m of G.monsters) {
    const startFx = m.fx, startFy = m.fy;
    m.moving = false;
    const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
    const dist = Math.hypot(p.px - mx, p.py - my);
    const los = hasLOS(mx, my, p.px, p.py);
    if (m.hitFlash > 0) m.hitFlash -= dt;
    const telegraphBefore = m.telegraph || 0;
    if (m.telegraph > 0) m.telegraph -= dt;
    const telegraphFinished = telegraphBefore > 0 && m.telegraph <= 0;
    if (m.atkCd > 0) m.atkCd -= dt;
    if (m.summonCd > 0) m.summonCd -= dt;
    if (m.dormant) {
      if (dist < 92 || m.hitFlash > 0) {
        m.dormant = false;
        m.aggro = true;
        m.behavior = 'charger';
        G.effects.push({ type: 'vfxCast', x: mx, y: my, dtype: 'fire', size: 64, life: .48, t: 0, color: m.color });
        log('The treasure chest has teeth!', '#e1a84c');
      }
    }
    // Aggro on sight OR proximity; once aggroed, stays (hunts via flow field).
    if (!m.dormant && ((dist < 260 && los) || dist < 130)) m.aggro = true;

    tickStatus(m, dt,
      (dmg, color) => { m.hp -= dmg; spawnDamageNumber(mx, my, Math.round(dmg), false, color === '#8fd14b' ? 'poison' : 'fire'); if (m.hp <= 0) killMonster(m); },
      () => {});
    if (m.hp <= 0) continue;

    const rooted = isRooted(m), silenced = isSilenced(m);
    const spd = m.spd * MOB_SPD * statusMul(m, 'moveMul') * (rooted ? 0 : 1);
    // Pack tactic: when badly hurt, a mob makes a brief fighting retreat — backs
    // off for ~1.2s (still shooting if ranged), then re-commits. It does NOT flee
    // forever (mobs don't heal, so waiting to "recover" would mean never fighting).
    const lowHP = !m.boss && m.hp < m.maxHp * 0.30;
    if (lowHP && !m.retreating && (m.retreatCd || 0) <= 0 && m.behavior !== 'charger') {
      m.retreating = true; m.retreatT = 1.2; m.retreatCd = 5;   // one retreat, then 5s before another
    }
    if (m.retreatCd > 0) m.retreatCd -= dt;
    if (m.retreating) { m.retreatT -= dt; if (m.retreatT <= 0) m.retreating = false; }

    if (m.aggro && !rooted) {
      if (m.retreating) {
        // fighting retreat: back toward open space, and STILL attack if ranged
        const ra = bestRetreatDir(mx, my);
        moveMob(m, mx + Math.cos(ra) * TILE * 4, my + Math.sin(ra) * TILE * 4, spd * 1.1, dt);
        if (!silenced && (m.behavior === 'caster' || m.behavior === 'bomber' || m.behavior === 'sentinel' || m.behavior === 'summoner')
            && los && m.atkCd <= 0) {
          enemyShoot(m, mx, my, m.special === 'volley' ? { count: 3, spread: 0.24, speed: 230 } : { speed: 235 });
          m.atkCd = 1.3;
        }
      } else {
      switch (m.behavior) {
        case 'charger': {
          if (m.chargeState === 'idle') {
            if (dist < 150 && los && m.atkCd <= 0) { m.chargeState = 'wind'; m.telegraph = 0.45; m.atkCd = 2.4; }
            else if (dist > 70) pathToPlayer(m, spd * 0.8, dt);           // path in (routes around walls)
            else moveMob(m, p.px, p.py, spd * 0.5, dt, -1);
          } else if (m.chargeState === 'wind') {
            if (m.telegraph <= 0) { const a = Math.atan2(p.py - my, p.px - mx); m.cvx = Math.cos(a); m.cvy = Math.sin(a); m.chargeState = 'dash'; m.chargeT = 0.35; }
          } else if (m.chargeState === 'dash') {
            m.chargeT -= dt;
            const dashSpd = spd * 3.4;
            const nx = mx + m.cvx * dashSpd * dt, ny = my + m.cvy * dashSpd * dt;
            if (!isWall(Math.floor(nx / TILE), Math.floor(my / TILE))) m.fx = (nx - TILE / 2) / TILE; else m.chargeT = 0;
            const cx = m.fx * TILE + TILE / 2;
            if (!isWall(Math.floor(cx / TILE), Math.floor(ny / TILE))) m.fy = (ny - TILE / 2) / TILE; else m.chargeT = 0;
            if (m.chargeT <= 0) m.chargeState = 'idle';
          }
          break;
        }
        case 'caster': {
          // Keep a shooting lane WITH line of sight. Retreat into OPEN space (not
          // corners). Dodge when the player aims at it. Hold mid-range and strafe.
          const ideal = 150;
          if (playerAimingAt(mx, my) && dist < 220 && m.dodgeCd <= 0) {
            dodgeStep(m, spd, dt); m.dodgeCd = 0.8;
          } else if (!los) {
            pathToPlayer(m, spd * 0.95, dt);   // move until it can see you again
          } else if (dist < ideal - 45) {
            // too close: retreat toward the most open direction away from player
            const ra = bestRetreatDir(mx, my);
            moveMob(m, mx + Math.cos(ra) * TILE * 4, my + Math.sin(ra) * TILE * 4, spd, dt);
          } else if (dist > ideal + 60) {
            pathToPlayer(m, spd * 0.9, dt);
          } else {
            const sa = Math.atan2(my - p.py, mx - p.px) + (m.strafeDir || (m.strafeDir = Math.random() < 0.5 ? 1 : -1)) * 0.5;
            moveMob(m, p.px + Math.cos(sa) * ideal, p.py + Math.sin(sa) * ideal, spd * 0.6, dt);
          }
          if (m.dodgeCd > 0) m.dodgeCd -= dt;
          if (!silenced && los && dist < 320 && m.atkCd <= 0 && m.telegraph <= 0) m.telegraph = 0.28;
          if (telegraphFinished && los && !silenced) {
            if (m.special === 'volley') enemyShoot(m, mx, my, { count: 3, spread: 0.24, speed: 230 });
            else enemyShoot(m, mx, my, { speed: 245 });
            m.atkCd = 1.1 + Math.random() * 0.5;
          }
          break;
        }
        case 'bomber': {
          // Advance to mid-range via pathing; lob arcs (can arc over low cover).
          if (dist > 100) pathToPlayer(m, spd * 0.8, dt);
          else if (dist < 60) moveMob(m, p.px, p.py, spd * 0.6, dt, -1);
          if (!silenced && dist < 280 && m.atkCd <= 0) { enemyShoot(m, mx, my, { speed: 165, arc: true, life: 2.6, dmgMul: 1.15 }); m.atkCd = 1.2; }
          break;
        }
        case 'leech': {
          if (dist > 42) {
            const fp = flankPoint(m, 48);
            pathToPoint(m, fp.x, fp.y, spd * 1.08, dt);
          } else pathToPlayer(m, spd, dt);
          break;
        }
        case 'sentinel': {
          const ideal = 175;
          if (!los || dist > ideal + 70) pathToPlayer(m, spd, dt);
          else if (dist < ideal - 55) moveMob(m, p.px, p.py, spd, dt, -1);
          if (telegraphFinished && m.telegraphKind === 'beam' && !silenced) {
            enemyShoot(m, mx, my, { speed: 390, life: 1.1, dmgMul: 1.35, r: 7 });
            G.effects.push({ type: 'beam', x: mx, y: my, x2: m.beamX, y2: m.beamY,
              dtype: 'lightning', color: '#55d7dc', life: .25, t: 0 });
            m.telegraphKind = null;
          } else if (!silenced && los && dist < 340 && m.atkCd <= 0 && m.telegraph <= 0) {
            m.telegraph = .62;
            m.telegraphKind = 'beam';
            m.beamX = p.px;
            m.beamY = p.py;
            m.atkCd = 2.7;
          }
          break;
        }
        case 'summoner': {
          const ideal = 190;
          if (!los || dist > ideal + 65) pathToPlayer(m, spd, dt);
          else if (dist < ideal - 65) moveMob(m, p.px, p.py, spd, dt, -1);
          if (!silenced && m.summonCd <= 0) {
            spawnSummon(m);
            m.summonCd = 5.5 + G.rng.float(0, 1.5);
          }
          if (!silenced && los && dist < 330 && m.atkCd <= 0) {
            enemyShoot(m, mx, my, { count: 2, spread: .18, speed: 205, dmgMul: .85 });
            m.atkCd = 1.8;
          }
          break;
        }
        case 'boss': {
          if (!m.enraged && m.hp < m.maxHp * .5) {
            m.enraged = true;
            m.spd *= 1.25;
            m.dmg = Math.round(m.dmg * 1.2);
            G.effects.push({ type: 'vfxCast', x: mx, y: my, dtype: m.proj || 'fire', size: 110, life: .8, t: 0, color: m.color });
            log(`${m.name} enters a second phase!`, '#ff8b42');
            screenShake(10);
          }
          if (dist > 40) pathToPlayer(m, spd, dt);
          if (!silenced && m.atkCd <= 0 && los) {
            m.atkCycle = (m.atkCycle || 0) + 1;
            if (dist < 360) enemyShoot(m, mx, my, { count: m.enraged ? 7 : 5, spread: m.enraged ? .24 : .30, speed: m.enraged ? 245 : 210 });
            if (m.enraged && m.atkCycle % 3 === 0) spawnSummon(m);
            m.atkCd = m.enraged ? 1.05 : 1.4;
          }
          break;
        }
        default: { // chaser
          if (m.dodgeCd > 0) m.dodgeCd -= dt;
          if (m.key === 'brute') {
            // Stone Brute: a slow tank. Lobs a slowing "boulder" at range to catch
            // a fleeing player, then closes for a big earthquake slam.
            if (dist > 55) pathToPlayer(m, spd, dt);
            else pathToPlayer(m, spd, dt);
            // Boulder toss: slows the player so the brute can close the gap.
            if (!silenced && dist > 60 && dist < 300 && m.atkCd <= 0 && m.telegraph <= 0) {
              m.telegraph = 0.4; m.telegraphKind = 'toss'; m.atkCd = 3.0;
            }
            // Earthquake slam when adjacent.
            if (!silenced && dist < 52 && m.atkCd <= 0 && m.telegraph <= 0) {
              m.telegraph = 0.6; m.telegraphKind = 'slam'; m.atkCd = 3.2;
            }
            // Resolve whichever telegraph finishes.
            if (telegraphFinished && !silenced) {
              if (m.telegraphKind === 'toss') {
                // heavy slow-moving boulder: earthy, big, applies a strong slow so
                // the lumbering brute can close the distance on a fleeing player
                enemyShoot(m, mx, my, {
                  speed: 135, life: 2.6, dmgMul: 0.8, r: 9, color: '#a88b63',
                  onHit: { status: 'slow', chance: 1, dur: 2.0 },
                });
              } else if (m.telegraphKind === 'slam' && dist < 75) {
                // big earthquake: wide radius, heavy hit, screen shake
                damagePlayer(Math.round(m.dmg * 1.9), null, m);
                G.effects.push({ type: 'ring', x: mx, y: my, r: 0, maxR: 95, life: .4, t: 0, color: '#c99a5a' });
                G.effects.push({ type: 'ring', x: mx, y: my, r: 0, maxR: 70, life: .3, t: 0, color: '#ff8a5c' });
                screenShake(11);
              }
              m.telegraphKind = null;
            }
          } else {
            // Nimble chasers (grubs) flank and sidestep your attacks.
            if (dist < 130 && dist > 30 && playerAimingAt(mx, my) && m.dodgeCd <= 0) {
              dodgeStep(m, spd, dt); m.dodgeCd = 0.9;
            } else if (dist > 55) {
              const fp = flankPoint(m, 60);
              pathToPoint(m, fp.x, fp.y, spd, dt);
            } else {
              pathToPlayer(m, spd, dt);
            }
          }
        }
      }
      }
    }

    m.moving = Math.hypot(m.fx - startFx, m.fy - startFy) > 0.0001;

    // melee contact damage
    if (dist < 18 && m.behavior !== 'boss') {
      if ((m.touchCd = (m.touchCd || 0) - dt) <= 0) {
        const contactDmg = m.behavior === 'charger' && m.chargeState === 'dash' ? Math.round(m.dmg * 1.6) : m.dmg;
        const touchStatus = m.behavior === 'leech' ? { status: 'bleed', chance: 1, dur: 2.8 } : null;
        damagePlayer(contactDmg, touchStatus, m);
        if (m.behavior === 'leech' || m.elite === 'vampiric') {
          m.hp = Math.min(m.maxHp, m.hp + contactDmg * (m.elite === 'vampiric' ? .5 : .32));
          G.effects.push({ type: 'vfxCast', x: mx, y: my, dtype: 'poison', size: 34, life: .35, t: 0, color: '#ef5263' });
        }
        m.touchCd = 0.5;
      }
    } else if (dist < 20 && m.boss) {
      if ((m.touchCd = (m.touchCd || 0) - dt) <= 0) { damagePlayer(m.dmg, null, m); m.touchCd = 0.45; }
    }
  }
}

// ---------- enemy projectiles ----------
function updateEnemyProjectiles(dt) {
  const p = G.player;
  for (const pr of G.eproj) {
    pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt;
    if (pr.arc) { pr.vx *= 0.985; pr.vy *= 0.985; } // arcing shots decelerate
    if (isWall(Math.floor(pr.x / TILE), Math.floor(pr.y / TILE))) pr.life = 0;
    if (Math.hypot(pr.x - p.px, pr.y - p.py) < 11) {
      damagePlayer(pr.dmg, pr.onHit, pr.owner);
      G.effects.push({ type: 'vfxHit', x: pr.x, y: pr.y, dtype: pr.ptype || 'phys', size: 42, life: .34, t: 0, color: pr.color });
      pr.life = 0;
    }
  }
  G.eproj = G.eproj.filter((x) => x.life > 0);
}

// ---------- projectiles ----------
function updateProjectiles(dt) {
  const p = G.player;
  for (const pr of G.projectiles) {
    pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt;
    if (isWall(Math.floor(pr.x / TILE), Math.floor(pr.y / TILE)) && !pr.pierce) pr.life = 0;
    for (const m of G.monsters) {
      if (pr.hitSet.has(m.id)) continue;
      const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
      if (Math.hypot(mx - pr.x, my - pr.y) < 12) {
        pr.hitSet.add(m.id);
        damageMonster(m, pr.dmg, pr.dtype, pr.onHit);
        G.effects.push({ type: 'vfxHit', x: pr.x, y: pr.y, dtype: pr.dtype, size: 42, life: .34, t: 0, color: pr.color });
        // chain: retarget to nearest unhit monster
        if (pr.chain > 0) {
          pr.chain--;
          let best = null, bd = 999;
          for (const o of G.monsters) { if (pr.hitSet.has(o.id)) continue; const d = Math.hypot(o.fx*TILE-pr.x, o.fy*TILE-pr.y); if (d < bd && d < 120) { bd = d; best = o; } }
          if (best) { const a = Math.atan2(best.fy*TILE+TILE/2 - pr.y, best.fx*TILE+TILE/2 - pr.x); const sp = Math.hypot(pr.vx,pr.vy); pr.vx = Math.cos(a)*sp; pr.vy = Math.sin(a)*sp; pr.life = 0.6; }
          else pr.life = 0;
        } else if (!pr.pierce) { pr.life = 0; }
      }
    }
  }
  G.projectiles = G.projectiles.filter((p2) => p2.life > 0);
}

// Expanding nova rings: each grows outward; any enemy whose distance from the
// ring's center falls within the ring front (a band) takes damage once.
function updateNovaRings(dt) {
  const p = G.player;
  if (!G.novaRings) return;
  for (const ring of G.novaRings) {
    ring.r += ring.speed * dt;
    const band = 16;   // thickness of the damaging ring front
    for (const m of G.monsters) {
      if (ring.hitSet.has(m.id)) continue;
      const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
      const d = Math.hypot(mx - ring.x, my - ring.y);
      if (d <= ring.r + band && d >= ring.r - band) {
        ring.hitSet.add(m.id);
        damageMonster(m, ring.dmg, ring.dtype, ring.onHit);
        G.effects.push({ type: 'vfxHit', x: mx, y: my, dtype: ring.dtype, size: 42, life: .34, t: 0, color: ring.color });
      }
    }
  }
  G.novaRings = G.novaRings.filter((r) => r.r < r.maxR);
}

function updateAbilityZones(dt) {
  for (const z of G.abilityZones || []) {
    z.t += dt;
    if (z.kind === 'meteor' && !z.done && z.t >= z.delay) {
      damageRadius(z.x, z.y, z.radius, z.dmg, z.dtype, z.onHit);
      G.effects.push({ type: 'vfxHit', x: z.x, y: z.y, dtype: z.dtype, size: z.radius * 2.25, life: .56, t: 0, color: z.color });
      G.effects.push({ type: 'ring', x: z.x, y: z.y, maxR: z.radius, life: .38, t: 0, color: z.color });
      z.done = true;
      screenShake(9);
    } else if (z.kind === 'vortex') {
      z.tick -= dt;
      for (const m of [...G.monsters]) {
        const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
        const dist = Math.hypot(mx - z.x, my - z.y);
        if (dist <= z.radius && dist > 8) moveMob(m, z.x, z.y, 34, dt);
      }
      if (z.tick <= 0) {
        damageRadius(z.x, z.y, z.radius, z.dmg, z.dtype, z.onHit);
        z.tick = .42;
      }
    } else if (z.kind === 'mine' && !z.done && z.t >= z.armed) {
      const triggered = G.monsters.some((m) => Math.hypot(m.fx * TILE + TILE / 2 - z.x, m.fy * TILE + TILE / 2 - z.y) < 25);
      if (triggered) {
        damageRadius(z.x, z.y, z.radius, z.dmg, z.dtype, z.onHit);
        G.effects.push({ type: 'vfxHit', x: z.x, y: z.y, dtype: z.dtype, size: z.radius * 2.1, life: .5, t: 0, color: z.color });
        z.done = true;
        screenShake(6);
      }
    }
  }
  G.abilityZones = (G.abilityZones || []).filter((z) => {
    if (z.kind === 'meteor') return !z.done;
    if (z.kind === 'mine') return !z.done && z.t < z.life;
    return z.t < z.life;
  });

  for (const orb of G.orbitals || []) {
    orb.t += dt;
    orb.angle += dt * 3.5;
    orb.x = G.player.px + Math.cos(orb.angle) * orb.radius;
    orb.y = G.player.py + Math.sin(orb.angle) * orb.radius;
    for (const [id, time] of orb.hitCd) {
      if (time <= dt) orb.hitCd.delete(id); else orb.hitCd.set(id, time - dt);
    }
    for (const m of [...G.monsters]) {
      if (orb.hitCd.has(m.id)) continue;
      const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
      if (Math.hypot(mx - orb.x, my - orb.y) < 18) {
        damageMonster(m, orb.dmg, orb.dtype, orb.onHit);
        orb.hitCd.set(m.id, .5);
        G.effects.push({ type: 'vfxHit', x: orb.x, y: orb.y, dtype: orb.dtype, size: 34, life: .28, t: 0, color: orb.color });
      }
    }
  }
  G.orbitals = (G.orbitals || []).filter((orb) => orb.t < orb.life);
}

// ---------- pickups / loot ----------
function updatePickups() {
  const p = G.player;
  for (const pu of G.pickups) {
    const px = pu.x * TILE + TILE / 2, py = pu.y * TILE + TILE / 2;
    if (Math.hypot(px - p.px, py - p.py) < 22 + p.stats.pickupRadius) {
      if (pu.type === 'gold') { G.gold += pu.amt; }
      else if (pu.type === 'hp') { p.hp = Math.min(p.maxHp, p.hp + pu.amt); }
      Audio.sfx('pickup');
      pu.dead = true;
    }
  }
  G.pickups = G.pickups.filter((x) => !x.dead);

  for (const d of G.drops) {
    const dx = d.x * TILE + TILE / 2, dy = d.y * TILE + TILE / 2;
    if (Math.hypot(dx - p.px, dy - p.py) < 20 + p.stats.pickupRadius) {
      G.player.bag.push(d.item);
      log(`Picked up ${d.item.name}`, d.item.rarityColor);
      d.dead = true;
      Audio.sfx('loot');
      // auto-equip if slot empty
      autoEquipIfBetter(d.item);
    }
  }
  G.drops = G.drops.filter((x) => !x.dead);
}

function itemScore(it) {
  if (!it) return -1;
  let s = it.ilvl * 2 + it.affixes.length * 4;
  if (it.stats.dmgHi) s += (it.stats.dmgLo + it.stats.dmgHi);
  if (it.stats.armor) s += it.stats.armor;
  return s;
}
function autoEquipIfBetter(it) {
  const slot = it.slot === 'weapon' ? 'weapon' : it.slot;
  if (!G.player.equip[slot]) { equipItem(it); }
}

// ---------- descend ----------
function checkStairs() {
  const p = G.player;
  const tx = Math.floor(p.px / TILE), ty = Math.floor(p.py / TILE);
  if (G.grid[ty]?.[tx] === T.STAIRS) {
    if (G.monsters.some((m) => m.boss)) { log('The warden bars the stairs.', 'var(--danger)'); return; }
    // Every 5th floor cleared (5,10,15...): offer to extract with 100% essence.
    const nextFloor = G.floor + 1;
    if (G.floor % 5 === 0 && !G.extractShownFor?.[G.floor]) {
      G.extractShownFor = G.extractShownFor || {};
      G.extractShownFor[G.floor] = true;
      openExtractChoice();
      return; // pause here; player chooses leave or descend
    }
    G.floorsCleared++;
    buildFloor(nextFloor);
    saveRun();
  }
}

// Total essence collected this run (for UI).
function runEssenceTotal() { return ESSENCE_TIERS.reduce((s, t) => s + (G.runEssence[t] || 0), 0); }

// Show the leave-or-continue overlay at a checkpoint.
function openExtractChoice() {
  G.paused = true;
  const total = runEssenceTotal();
  const breakdown = ESSENCE_TIERS.filter((t) => G.runEssence[t] > 0)
    .map((t) => `<span style="color:${ESSENCE_COLOR[t]}">${G.runEssence[t]} ${t}</span>`).join(' · ') || 'none yet';
  document.getElementById('extractBreakdown').innerHTML =
    `You've collected <b>${total}</b> essence this run: ${breakdown}.`
    + (Account.authed ? '' : `<br><span style="color:var(--danger);font-size:12px">You're playing as a guest — log in to actually bank essence.</span>`);
  document.getElementById('extractFloor').textContent = `FLOOR ${G.floor} CHECKPOINT`;
  document.getElementById('extractModal').style.display = 'flex';
}

// End a run permanently: delete its server save and clear the local resume
// pointer so it can't be reloaded (prevents banking essence then resuming).
async function endRunPermanently() {
  const id = G?.id;
  localStorage.removeItem('seedspire_last');
  if (id) { try { await fetch(`/api/save/${id}`, { method: 'DELETE', headers: Account.headers() }); } catch {} }
}

// Leave now: bank 100% and return to menu.
async function extractLeave() {
  document.getElementById('extractModal').style.display = 'none';
  G.alive = false; G.paused = false;
  const res = await apiBankEssence(G.runEssence, 1.0);
  await fetch('/api/score', { method: 'POST', headers: Account.headers(),
    body: JSON.stringify({ name: Account.username || G.name, seed: G.seed, floor: G.floor, level: G.player.level }) }).catch(()=>{});
  await endRunPermanently();
  showBankedSummary(res, true);
}

// Descend: keep playing, essence stays at risk.
function extractContinue() {
  document.getElementById('extractModal').style.display = 'none';
  G.paused = false;
  G.floorsCleared++;
  buildFloor(G.floor + 1);
  saveRun();
}

// ---------- game over ----------
async function gameOver() {
  if (!G.alive) return;
  G.alive = false;
  log('You have fallen.', 'var(--danger)');
  Audio.sfx('death');
  // Death: bank only 30% of collected essence.
  let res = null;
  if (Account.authed) res = await apiBankEssence(G.runEssence, 0.3);
  await fetch('/api/score', { method: 'POST', headers: Account.authed ? Account.headers() : { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: Account.username || G.name, seed: G.seed, floor: G.floor, level: G.player.level }) }).catch(()=>{});
  await endRunPermanently();
  setTimeout(() => showBankedSummary(res, false), 1000);
}

// Summary overlay after a run ends (either way), showing what got banked.
function showBankedSummary(res, clean) {
  const el = document.getElementById('deathModal');
  const title = document.getElementById('deathTitle');
  const body = document.getElementById('deathBody');
  if (clean) { title.textContent = 'EXTRACTED SAFELY'; title.style.color = 'var(--accent)'; }
  else { title.textContent = 'YOU FELL'; title.style.color = 'var(--danger)'; }
  if (res && res.gained) {
    const parts = ESSENCE_TIERS.filter((t) => res.gained[t] > 0)
      .map((t) => `<span style="color:${ESSENCE_COLOR[t]}">+${res.gained[t]} ${t}</span>`).join(' · ');
    const pct = clean ? '100%' : '30%';
    body.innerHTML = `Reached floor <b>${G.floor}</b>. Banked <b>${pct}</b> of your essence:<br>${parts || 'none'}<br>` +
      `<span style="color:var(--dim);font-size:12px">Total vault: ${ESSENCE_TIERS.map((t)=>`${Account.essence[t]} ${t}`).join(' · ')}</span>`;
  } else {
    body.innerHTML = `Reached floor <b>${G.floor}</b>.` + (Account.authed ? '' : '<br><span style="color:var(--dim);font-size:12px">Log in to bank essence between runs.</span>');
  }
  el.style.display = 'flex';
}

// ---------- effects & juice ----------
let shake = 0;
function screenShake(a) { shake = Math.min(12, shake + a); }
const dmgNumbers = [];
function spawnDamageNumber(x, y, val, crit, dtype) {
  const colors = { phys: '#fff', fire: '#ff7a3c', cold: '#63c6ff', lightning: '#ffe14a', void: '#b46bff', poison: '#8fd14b', text: '#7fe' };
  dmgNumbers.push({ x, y, val, crit, life: .8, t: 0, color: colors[dtype] || '#fff' });
}
function log(msg, color = 'var(--dim)') {
  const el = document.getElementById('log');
  const d = document.createElement('div');
  d.textContent = msg; d.style.color = color;
  el.prepend(d);
  while (el.children.length > 6) el.lastChild.remove();
  setTimeout(() => { d.style.transition = 'opacity 1s'; d.style.opacity = '0'; }, 4000);
}

// ---------- main loop ----------
function update(dt) {
  const p = G.player;
  if (!G.alive) return;
  // regen
  p.hp = Math.min(p.maxHp, p.hp + p.stats.regen * dt);
  // tick status effects (burn/poison drain HP; regen buff heals)
  tickStatus(p, dt,
    (dmg) => { p.hp -= dmg; if (p.hp <= 0) gameOver(); },
    (heal) => { p.hp = Math.min(p.maxHp, p.hp + heal); });
  // timers
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.invuln > 0) p.invuln -= dt;
  if (p.dashCd > 0) p.dashCd -= dt;
  if (p.swingCd > 0) p.swingCd -= dt;
  for (const ab of p.abilities) if (ab.cdLeft > 0) ab.cdLeft -= dt;
  // Defensive procs: periodic ones fire on their timer; all tick their cooldown.
  if (p.defenses) for (const df of p.defenses) {
    if (df.cdLeft > 0) df.cdLeft -= dt;
    if (df.trigger === 'periodic' && df.cdLeft <= 0) {
      applyStatus(p, df.buff, df.dur, 1);
      df.cdLeft = df.cd;
    }
  }

  const rooted = isRooted(p);   // frozen/stunned: can't move

  // movement
  let mx = 0, my = 0;
  if (keys['w'] || keys['arrowup']) my -= 1;
  if (keys['s'] || keys['arrowdown']) my += 1;
  if (keys['a'] || keys['arrowleft']) mx -= 1;
  if (keys['d'] || keys['arrowright']) mx += 1;
  mx += touchVec.x; my += touchVec.y;
  const mag = Math.hypot(mx, my);
  p.moving = (mag > 0 && !rooted);
  if (mag > 0 && !rooted) {
    mx /= mag; my /= mag;
    p.dir = { x: mx, y: my };
    const moveMul = statusMul(p, 'moveMul');   // chill/slow (down) or haste (up)
    const speed = 100 * (1 + p.stats.moveSpeed) * (p.dashT > 0 ? 2.4 : 1) * moveMul;
    const nx = p.px + mx * speed * dt, ny = p.py + my * speed * dt;
    if (canMove(nx, p.py)) p.px = nx;
    if (canMove(p.px, ny)) p.py = ny;
  }
  if (p.dashT > 0) p.dashT -= dt;
  // dash (blocked while rooted)
  if ((keys['k'] || keys[' ']) && p.dashCd <= 0 && !rooted) { p.dashT = 0.16; p.dashCd = 1.2; p.invuln = 0.2; }

  // attacks
  const aimX = mouse.x - VIEW_TILES_X * TILE / 2 + p.px;
  const aimY = mouse.y - VIEW_TILES_Y * TILE / 2 + p.py;
  if (keys['j'] || mouse.down || firing) {
    // primary ability (main-hand weapon), else a melee swing
    if (p.abilities[0]) fireAbility(0, aimX, aimY);
    else meleeSwing();
  }
  // secondary ability (off-hand weapon): L key or right mouse button.
  if (keys['l'] || mouse.right) {
    if (p.abilities[1]) fireAbility(1, aimX, aimY);           // has off-hand: fire it
    else if (mouse.right && p.abilities[0]) fireAbility(0, aimX, aimY); // no off-hand: RMB still attacks
  }
  if (keys['u']) meleeSwing();

  updateMonsters(dt);
  updateProjectiles(dt);
  updateNovaRings(dt);
  updateAbilityZones(dt);
  updateEnemyProjectiles(dt);
  updatePickups();
  checkStairs();

  for (const e of G.effects) e.t += dt;
  G.effects = G.effects.filter((e) => e.t < e.life);
  for (const dn of dmgNumbers) { dn.t += dt; dn.y -= 20 * dt; }
  for (let i = dmgNumbers.length - 1; i >= 0; i--) if (dmgNumbers[i].t >= dmgNumbers[i].life) dmgNumbers.splice(i, 1);
  if (shake > 0) shake = Math.max(0, shake - dt * 40);

  updateHUD();
}

// ---------- rendering ----------
function draw() {
  const p = G.player;
  const camX = p.px - VIEW_TILES_X * TILE / 2 + (Math.random() - 0.5) * shake;
  const camY = p.py - VIEW_TILES_Y * TILE / 2 + (Math.random() - 0.5) * shake;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#0e1017';
  ctx.fillRect(0, 0, VIEW_TILES_X * TILE, VIEW_TILES_Y * TILE);

  const t0x = Math.floor(camX / TILE), t0y = Math.floor(camY / TILE);
  // floor & special tiles
  for (let ty = t0y - 1; ty <= t0y + VIEW_TILES_Y + 1; ty++) {
    for (let tx = t0x - 1; tx <= t0x + VIEW_TILES_X + 1; tx++) {
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) continue;
      const cell = G.grid[ty][tx];
      if (cell === T.WALL) continue;
      const sx = Math.round(tx * TILE - camX), sy = Math.round(ty * TILE - camY);
      // deterministic flagstone variant per tile
      const variant = (tx * 7 + ty * 13) & 3;
      const rareRune = ((tx * 31 + ty * 19) & 63) === 0;
      const hdFloorCol = rareRune ? 2 : (variant === 1 ? 1 : 0);
      if (!drawArtCell(HD.environment, hdFloorCol, 0, 4, 2, sx, sy, TILE, TILE)) {
        ctx.drawImage(SPR.floor[variant], sx, sy, TILE, TILE);
      }
      // A hairline of reflected light where carved stone meets the dark.
      // It makes room silhouettes legible without flattening the pixel art.
      if (G.grid[ty - 1]?.[tx] === T.WALL) {
        ctx.fillStyle = 'rgba(128,176,178,.09)';
        ctx.fillRect(sx, sy, TILE, 1);
      }
      if (((tx * 29 + ty * 17) & 31) === 0) {
        ctx.fillStyle = 'rgba(116,243,207,.08)';
        ctx.fillRect(sx + 4, sy + 5, 1, 1);
      }
      if (cell === T.STAIRS) {
        const pulse = 0.72 + 0.28 * Math.sin(Date.now() / 300);
        if (!drawArtCell(HD.environment, 2, 1, 4, 2, sx, sy, TILE, TILE, false, pulse)) {
          ctx.globalAlpha = pulse; ctx.drawImage(SPR.stairs, sx, sy, TILE, TILE); ctx.globalAlpha = 1;
        }
      }
      if (cell === T.ENTRY && !drawArtCell(HD.environment, 3, 1, 4, 2, sx, sy, TILE, TILE)) ctx.drawImage(SPR.entry, sx, sy, TILE, TILE);
    }
  }
  // walls (drawn only where adjacent to floor, so interiors stay black = depth)
  for (let ty = t0y - 1; ty <= t0y + VIEW_TILES_Y + 1; ty++)
    for (let tx = t0x - 1; tx <= t0x + VIEW_TILES_X + 1; tx++) {
      if (tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) continue;
      if (G.grid[ty][tx] !== T.WALL) continue;
      let edge=false; for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) { const nx=tx+dx,ny=ty+dy; if(nx>=0&&ny>=0&&nx<MAP_W&&ny<MAP_H&&G.grid[ny][nx]!==T.WALL) edge=true; }
      if (!edge) continue;
      const sx = Math.round(tx*TILE-camX), sy=Math.round(ty*TILE-camY);
      const rootWall = ((tx * 17 + ty * 23) & 15) === 0;
      if (!drawArtCell(HD.environment, rootWall ? 1 : 0, 1, 4, 2, sx, sy, TILE, TILE)) ctx.drawImage(SPR.wall, sx, sy, TILE, TILE);
      if (G.grid[ty + 1]?.[tx] !== T.WALL) {
        ctx.fillStyle = 'rgba(2,4,8,.58)'; ctx.fillRect(sx, sy + TILE - 2, TILE, 3);
        ctx.fillStyle = 'rgba(122,153,166,.16)'; ctx.fillRect(sx, sy + TILE - 2, TILE, 1);
      }
    }

  // Slow seed-motes drift through open rooms. Their world positions are
  // deterministic, so they feel atmospheric rather than like UI confetti.
  const moteTime = Date.now() / 1000;
  for (let i = 0; i < 34; i++) {
    const wx = (i * 173.7 + moteTime * (3.2 + (i % 3))) % (MAP_W * TILE);
    const wy = (i * 97.3 + Math.sin(moteTime * .38 + i) * 13 + MAP_H * TILE) % (MAP_H * TILE);
    const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H || G.grid[ty][tx] === T.WALL) continue;
    const sx = Math.round(wx - camX), sy = Math.round(wy - camY);
    if (sx < 0 || sy < 0 || sx > cv.width || sy > cv.height) continue;
    const twinkle = .12 + .16 * (1 + Math.sin(moteTime * 1.4 + i * 2.1)) / 2;
    ctx.fillStyle = `rgba(${i % 5 === 0 ? '169,122,255' : '116,243,207'},${twinkle})`;
    ctx.fillRect(sx, sy, i % 7 === 0 ? 2 : 1, 1);
  }

  // pickups
  for (const pu of G.pickups) {
    const sx = Math.round(pu.x*TILE+TILE/2-camX), sy=Math.round(pu.y*TILE+TILE/2-camY + Math.sin(Date.now()/250 + pu.x)*1.5);
    const spr = pu.type === 'gold' ? SPR.gold : SPR.hp;
    ctx.shadowColor = pu.type === 'gold' ? '#f0b341' : '#ff5d6c'; ctx.shadowBlur = 6;
    ctx.drawImage(spr, sx - 7, sy - 7);
    ctx.shadowBlur = 0;
  }
  // drops (glowing loot with a light beam so they're findable)
  for (const d of G.drops) {
    const sx=Math.round(d.x*TILE+TILE/2-camX), sy=Math.round(d.y*TILE+TILE/2-camY);
    const bob = Math.sin(Date.now()/400 + d.x)*2;
    const col = d.item.rarityColor;
    // vertical light beam
    const beam = ctx.createLinearGradient(0, sy-24, 0, sy+4);
    beam.addColorStop(0, 'rgba(0,0,0,0)'); beam.addColorStop(1, col);
    ctx.globalAlpha=.28; ctx.fillStyle=beam; ctx.fillRect(sx-3, sy-24, 6, 28); ctx.globalAlpha=1;
    ctx.shadowColor=col; ctx.shadowBlur=10;
    if (!drawArtCell(HD.characters, HD_TREASURE_CELL[0], HD_TREASURE_CELL[1], 4, 3, sx-22, sy-22+bob, 44, 39)) {
      ctx.fillStyle=col;
      ctx.beginPath();
      ctx.moveTo(sx, sy-5+bob); ctx.lineTo(sx+4, sy+bob); ctx.lineTo(sx, sy+5+bob); ctx.lineTo(sx-4, sy+bob); ctx.closePath();
      ctx.fill();
      ctx.fillStyle='rgba(255,255,255,.6)'; ctx.beginPath(); ctx.moveTo(sx,sy-5+bob); ctx.lineTo(sx+2,sy-1+bob); ctx.lineTo(sx,sy+bob); ctx.closePath(); ctx.fill();
    }
    ctx.shadowBlur=0;
  }

  // persistent ability fields live on the ground beneath actors.
  for (const z of G.abilityZones || []) {
    const sx = z.x - camX, sy = z.y - camY;
    if (z.kind === 'meteor') {
      const charge = Math.min(1, z.t / z.delay);
      const markerR = z.radius * (.72 + charge * .28);
      ctx.save(); ctx.fillStyle = z.color; ctx.globalAlpha = .1 + charge * .06;
      ctx.beginPath(); ctx.arc(sx, sy, markerR, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = z.color; ctx.globalAlpha = .55 + charge * .3; ctx.lineWidth = 2 + charge * 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, markerR, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4 + charge * .45;
        ctx.beginPath(); ctx.moveTo(sx + Math.cos(a) * markerR * .68, sy + Math.sin(a) * markerR * .68);
        ctx.lineTo(sx + Math.cos(a) * markerR * .9, sy + Math.sin(a) * markerR * .9); ctx.stroke();
      }
      ctx.restore();
      drawVfx(z.dtype, Math.min(3, Math.floor(charge * 4)), sx, sy, z.radius * 2.2, -charge * 2, .78);
    } else if (z.kind === 'vortex') {
      const fade = Math.min(1, (z.life - z.t) * 2);
      ctx.save(); ctx.globalAlpha = .16 * fade; ctx.fillStyle = z.color; ctx.beginPath(); ctx.arc(sx, sy, z.radius, 0, 7); ctx.fill(); ctx.restore();
      drawVfx(z.dtype, effectFrame(z.t * 1000, 0, 8, 85), sx, sy, z.radius * 1.8, -z.t * 2.2, .64 * fade);
    } else if (z.kind === 'mine') {
      const armed = z.t >= z.armed;
      ctx.save(); ctx.strokeStyle = z.color; ctx.globalAlpha = armed ? .8 : .32; ctx.lineWidth = armed ? 2 : 1;
      ctx.beginPath(); ctx.arc(sx, sy, 13 + Math.sin(Date.now() / 120) * 2, 0, 7); ctx.stroke(); ctx.restore();
      drawVfx(z.dtype, effectFrame(z.t * 1000, 0, 4, 100), sx, sy, 38, z.t * 1.5, armed ? .75 : .4);
    }
  }

  // monsters
  for (const m of G.monsters) {
    const sx=Math.round(m.fx*TILE+TILE/2-camX), sy=Math.round(m.fy*TILE+TILE/2-camY);
    const sprObj = SPR.mob[m.key] || SPR.mob.grub;
    const spr = frameFor(sprObj, m.fx * 0.7);   // phase by position so they don't sync
    const walkAtlas = HD_MOB_WALK[m.key];
    const hdCell = HD_MOB_CELL[m.key];
    const useWalk = artReady(walkAtlas);
    const useHd = useWalk || (!!hdCell && artReady(HD.characters));
    const mobSize = HD_MOB_SIZE[m.key] || (m.boss ? [76,72] : [46,42]);
    const dw = useHd ? mobSize[0] : (m.boss ? 54 : 36);
    const dh = useHd ? mobSize[1] : dw;
    const now = Date.now();
    const phase = (Number(m.id) || Math.round(m.fx * 13 + m.fy * 17)) * 37;
    const walkCell = m.moving ? movementCell(now, HD_MOB_FRAME_MS[m.key] || 125, phase) : [0, 0];
    if (m.elite) {
      ctx.save(); ctx.strokeStyle = m.color; ctx.globalAlpha = .38 + .18 * Math.sin(now / 160 + phase); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(sx, sy + dh * .22, dw * .42, dh * .13, 0, 0, 7); ctx.stroke();
      if (m.eliteShield > 0) { ctx.globalAlpha = .55; ctx.beginPath(); ctx.arc(sx, sy, Math.max(dw, dh) * .48, 0, 7); ctx.stroke(); }
      ctx.restore();
    }
    // telegraph flash before a special attack — the player's cue to react
    if (m.telegraph > 0) {
      if (m.telegraphKind === 'beam') {
        ctx.save(); ctx.strokeStyle = '#79f4ff'; ctx.shadowColor = '#55d7dc'; ctx.shadowBlur = 8;
        ctx.globalAlpha = .35 + .45 * Math.abs(Math.sin(now / 45)); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(m.beamX - camX, m.beamY - camY); ctx.stroke(); ctx.restore();
      } else if (m.telegraphKind === 'slam') {
        // earthquake wind-up: a large growing danger ring on the ground you must leave
        const t = 1 - m.telegraph / 0.6;
        ctx.strokeStyle = '#e0a850'; ctx.lineWidth = 3; ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(Date.now()/50));
        ctx.beginPath(); ctx.arc(sx, sy, 20 + t * 75, 0, 7); ctx.stroke();
        ctx.globalAlpha = 0.2; ctx.fillStyle = '#e0a850';
        ctx.beginPath(); ctx.arc(sx, sy, 20 + t * 75, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      } else {
        const t = 1 - m.telegraph / 0.5;
        ctx.strokeStyle = m.telegraphKind === 'toss' ? '#a88b63' : '#ffcf5c'; ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4 + 0.6 * Math.abs(Math.sin(Date.now()/60));
        ctx.beginPath(); ctx.arc(sx, sy, (dw/2) + 2 + t * 5, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    if (m.chargeState === 'dash') { ctx.shadowColor = m.color; ctx.shadowBlur = 14; }
    // Grounding shadow keeps larger sprites from appearing to float over tiles.
    ctx.save(); ctx.globalAlpha = m.boss ? .5 : .34; ctx.fillStyle = '#020306';
    ctx.beginPath(); ctx.ellipse(sx, sy + dh*.22, dw*.27, Math.max(2.5,dh*.075), 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    // face the player: flip horizontally if player is to the left
    const faceLeft = G.player.px < (m.fx*TILE+TILE/2);
    if (useWalk) drawCenteredArtCell(walkAtlas, walkCell[0], walkCell[1], 4, 2, sx, sy, dw, dh, faceLeft);
    else if (useHd) drawCenteredArtCell(HD.characters, hdCell[0], hdCell[1], 4, 3, sx, sy, dw, dh, faceLeft);
    else {
      ctx.save(); ctx.translate(sx, sy); if (faceLeft) ctx.scale(-1, 1);
      ctx.drawImage(spr, -dw/2, -dh/2, dw, dh); ctx.restore();
    }
    ctx.shadowBlur = 0;
    // hit flash: white silhouette overlay using the sprite as a mask
    if (m.hitFlash > 0) {
      ctx.save(); ctx.globalAlpha = m.hitFlash / 0.15 * 0.8; ctx.globalCompositeOperation = 'lighter';
      if (useWalk) drawCenteredArtCell(walkAtlas, walkCell[0], walkCell[1], 4, 2, sx, sy, dw, dh, faceLeft);
      else if (useHd) drawCenteredArtCell(HD.characters, hdCell[0], hdCell[1], 4, 3, sx, sy, dw, dh, faceLeft);
      else { ctx.translate(sx, sy); if (faceLeft) ctx.scale(-1,1); ctx.drawImage(spr, -dw/2, -dh/2, dw, dh); }
      ctx.restore();
    }
    // hp bar
    if (m.hp < m.maxHp) { const bw = dw*0.5; ctx.fillStyle='#2a0f16'; ctx.fillRect(sx-bw,sy-dh/2-2,bw*2,3); ctx.fillStyle='#ff4b5c'; ctx.fillRect(sx-bw,sy-dh/2-2,bw*2*(m.hp/m.maxHp),3); }
    // status pips
    const st = activeStatusList(m);
    if (st.length) st.slice(0,4).forEach((s,i)=>{ ctx.fillStyle=s.color; ctx.beginPath(); ctx.arc(sx-dw*0.4+i*6, sy-dh/2-7, 2.4, 0, 7); ctx.fill(); });
    // frozen tint
    if (hasStatus(m,'freeze')) { ctx.fillStyle='rgba(120,210,255,.22)'; ctx.beginPath(); ctx.ellipse(sx,sy,Math.max(14,dw*.32),Math.max(16,dh*.42),0,0,Math.PI*2); ctx.fill(); }
  }

  // nova rings — solid expanding circle of force
  if (G.novaRings) for (const ring of G.novaRings) {
    const sx = ring.x - camX, sy = ring.y - camY;
    const fade = 1 - ring.r / ring.maxR;
    ctx.strokeStyle = ring.color; ctx.shadowColor = ring.color; ctx.shadowBlur = 12;
    ctx.globalAlpha = 0.4 + 0.5 * fade; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(sx, sy, ring.r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2; ctx.globalAlpha = 0.25 * fade;
    ctx.beginPath(); ctx.arc(sx, sy, ring.r - 5, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  // orbiting attacks
  for (const orb of G.orbitals || []) {
    const sx = orb.x - camX, sy = orb.y - camY;
    drawVfx(orb.dtype, effectFrame(orb.t * 1000, 0, 8, 70), sx, sy, 38, orb.angle + Math.PI / 2, .9);
  }
  // projectiles (player)
  for (const pr of G.projectiles) {
    const sx=pr.x-camX, sy=pr.y-camY;
    const ang = Math.atan2(pr.vy, pr.vx);
    ctx.save(); ctx.strokeStyle = pr.color; ctx.globalAlpha = .36; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx - Math.cos(ang) * 16, sy - Math.sin(ang) * 16); ctx.lineTo(sx, sy); ctx.stroke(); ctx.restore();
    if (!drawVfx(pr.dtype, effectFrame(Date.now() + pr.phase, 0, 4, 62), sx, sy, pr.shape === 'cleave' ? 34 : 28, ang, .92)) {
      ctx.shadowColor=pr.color; ctx.shadowBlur=8; ctx.fillStyle=pr.color; ctx.beginPath(); ctx.arc(sx,sy,4,0,7); ctx.fill(); ctx.shadowBlur=0;
    }
  }
  // projectiles (enemy) — drawn with a dark core so they read as incoming threats
  for (const pr of G.eproj) {
    const sx=pr.x-camX, sy=pr.y-camY;
    const ang = Math.atan2(pr.vy, pr.vx);
    if (!drawVfx(pr.ptype || 'phys', effectFrame(Date.now(), 0, 4, 76), sx, sy, 25 + pr.r * 2, ang, .9)) {
      ctx.shadowColor=pr.color; ctx.shadowBlur=9; ctx.fillStyle=pr.color; ctx.beginPath(); ctx.arc(sx,sy,pr.r,0,7); ctx.fill();
      ctx.shadowBlur=0; ctx.fillStyle='rgba(0,0,0,.45)'; ctx.beginPath(); ctx.arc(sx,sy,pr.r*0.45,0,7); ctx.fill();
    }
  }

  // effects
  for (const e of G.effects) drawEffect(e, camX, camY);

  // player
  const psx=Math.round(p.px-camX), psy=Math.round(p.py-camY);
  if (p.invuln>0 && Math.floor(Date.now()/60)%2) {} else {
    const now = Date.now();
    ctx.shadowColor = p.dashT>0 ? '#6fe3c4' : '#ff5d6c';
    ctx.shadowBlur = p.dashT>0 ? 14 : (hasStatus(p,'rage') ? 4 : 0);
    const faceLeft = p.dir.x < -0.1;
    const hero = characterById(p.characterId);
    const hspr = frameFor(SPR.hero?.[p.characterId] || SPR.hero?.wanderer || SPR.hero, p.moving ? now/60 : 0);
    const heroWalkAtlas = HD_HERO_WALK[p.characterId] || HD_HERO_WALK.wanderer;
    const useHeroWalk = artReady(heroWalkAtlas);
    const heroWalkCell = p.moving ? movementCell(now, 105) : [0, 0];
    const heroCol = HD_HERO_COL[p.characterId] ?? HD_HERO_COL.wanderer;
    const useHdHero = useHeroWalk || artReady(HD.characters);
    // Keep the readable silhouette close to a single 20-unit corridor tile.
    const heroW = 36, heroH = useHdHero ? 42 : 36;
    // A restrained sigil under the hero makes the focal point instantly clear.
    ctx.save(); ctx.globalAlpha = .22 + Math.sin(Date.now()/420) * .035; ctx.strokeStyle = hero.color || '#6fe3c4'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(psx, psy + 7, 10, 4, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = .09; ctx.beginPath(); ctx.moveTo(psx - 7, psy + 7); ctx.lineTo(psx, psy + 2); ctx.lineTo(psx + 7, psy + 7); ctx.closePath(); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.globalAlpha = .38; ctx.fillStyle = '#020306'; ctx.beginPath(); ctx.ellipse(psx, psy + 8, 8, 2.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    if (useHeroWalk) drawCenteredArtCell(heroWalkAtlas, heroWalkCell[0], heroWalkCell[1], 4, 2, psx, psy, heroW, heroH, faceLeft);
    else if (useHdHero) drawCenteredArtCell(HD.characters, heroCol, 0, 4, 3, psx, psy, heroW, heroH, faceLeft);
    else { ctx.save(); ctx.translate(psx, psy); if (faceLeft) ctx.scale(-1,1); ctx.drawImage(hspr, -18, -20, 36, 36); ctx.restore(); }
    ctx.shadowBlur = 0;
    // hit flash
    if (p.hitFlash > 0) { ctx.save(); ctx.globalAlpha = p.hitFlash/0.2*0.7; ctx.globalCompositeOperation='lighter'; if (useHeroWalk) drawCenteredArtCell(heroWalkAtlas,heroWalkCell[0],heroWalkCell[1],4,2,psx,psy,heroW,heroH,faceLeft); else if (useHdHero) drawCenteredArtCell(HD.characters,heroCol,0,4,3,psx,psy,heroW,heroH,faceLeft); else { ctx.translate(psx,psy); if(faceLeft)ctx.scale(-1,1); ctx.drawImage(hspr,-18,-20,36,36); } ctx.restore(); }
    // small facing dot toward aim, tinted by selected character
    ctx.fillStyle=hero.color || '#6fe3c4'; ctx.globalAlpha=.8; ctx.beginPath(); ctx.arc(psx+p.dir.x*8, psy+p.dir.y*8, 1.6, 0, 7); ctx.fill(); ctx.globalAlpha=1;
    // shield buff ring
    if (hasStatus(p,'shield')) { ctx.strokeStyle='#8fd1ff'; ctx.lineWidth=1.5; ctx.globalAlpha=.7; ctx.beginPath(); ctx.arc(psx,psy,10,0,7); ctx.stroke(); ctx.globalAlpha=1; }
  }

  // damage numbers
  ctx.textAlign='center';
  for (const dn of dmgNumbers) {
    const a=1-dn.t/dn.life;
    ctx.globalAlpha=a; ctx.fillStyle=dn.color;
    ctx.font=`bold ${dn.crit?16:12}px monospace`;
    ctx.fillText(typeof dn.val==='number'?Math.round(dn.val):dn.val, dn.x-camX, dn.y-camY);
    ctx.globalAlpha=1;
  }

  // Layered light: a faint character-colored bloom, then deep indigo fog.
  // Both are post-process passes, so combat silhouettes remain crisp.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const bloom = ctx.createRadialGradient(psx, psy, 12, psx, psy, 155);
  bloom.addColorStop(0, 'rgba(116,243,207,.055)');
  bloom.addColorStop(.5, 'rgba(73,116,126,.025)');
  bloom.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bloom; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.restore();
  const grad=ctx.createRadialGradient(psx,psy,105,psx,psy,430);
  grad.addColorStop(0,'rgba(2,4,8,0)'); grad.addColorStop(.55,'rgba(3,5,10,.12)'); grad.addColorStop(1,'rgba(2,3,8,.72)');
  ctx.fillStyle=grad; ctx.fillRect(0,0,VIEW_TILES_X*TILE,VIEW_TILES_Y*TILE);
  const edgeFog = ctx.createLinearGradient(0,0,0,cv.height);
  edgeFog.addColorStop(0,'rgba(12,9,22,.18)'); edgeFog.addColorStop(.28,'rgba(0,0,0,0)'); edgeFog.addColorStop(1,'rgba(1,3,7,.2)');
  ctx.fillStyle=edgeFog; ctx.fillRect(0,0,cv.width,cv.height);
}

function drawEffect(e, camX, camY) {
  const sx=e.x-camX, sy=e.y-camY, prog=e.t/e.life;
  ctx.globalAlpha=1-prog;
  if (e.type==='vfxHit') {
    drawVfx(e.dtype || 'phys', 4 + Math.min(3, Math.floor(prog * 4)), sx, sy, (e.size || 44) * (1 + prog * .18), prog * .7, 1 - prog * .35);
  }
  else if (e.type==='vfxCast') {
    drawVfx(e.dtype || 'phys', Math.min(7, Math.floor(prog * 8)), sx, sy, e.size || 42, -prog * .8, 1 - prog * .45);
  }
  else if (e.type==='beam') {
    const ex = e.x2 - camX, ey = e.y2 - camY;
    ctx.save(); ctx.globalAlpha = 1 - prog; ctx.strokeStyle = e.color; ctx.shadowColor = e.color; ctx.shadowBlur = 14;
    ctx.lineWidth = 10 * (1 - prog) + 2; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.globalAlpha *= .65; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.restore();
    for (let i = 1; i <= 4; i++) drawVfx(e.dtype || 'lightning', 4 + Math.min(3, Math.floor(prog * 4)),
      sx + (ex - sx) * i / 5, sy + (ey - sy) * i / 5, 28, Math.atan2(ey - sy, ex - sx), .55 * (1 - prog));
  }
  else if (e.type==='ring'){ ctx.strokeStyle=e.color; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(sx,sy,prog*e.maxR,0,7); ctx.stroke(); }
  else if (e.type==='hit'){ ctx.fillStyle=e.color; ctx.beginPath(); ctx.arc(sx,sy,6*(1-prog)+2,0,7); ctx.fill(); }
  else if (e.type==='swing'||e.type==='arc'){
    ctx.strokeStyle=e.color; ctx.shadowColor=e.color; ctx.shadowBlur=8; ctx.lineWidth=5*(1-prog)+1;
    ctx.beginPath(); ctx.arc(sx,sy,26+prog*9,e.ang-0.8,e.ang+0.8); ctx.stroke(); ctx.shadowBlur=0;
    if (e.dtype) drawVfx(e.dtype, Math.min(7, Math.floor(prog*8)), sx+Math.cos(e.ang)*24, sy+Math.sin(e.ang)*24, 42, e.ang, .7*(1-prog));
  }
  else if (e.type==='levelup'){ ctx.strokeStyle='#6fe3c4'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(sx,sy,prog*40,0,7); ctx.stroke(); }
  ctx.globalAlpha=1;
}

// ---------- HUD ----------
function updateHUD() {
  const p = G.player;
  document.getElementById('hpText').textContent = `HP ${Math.ceil(p.hp)}/${p.maxHp}`;
  document.getElementById('hpBar').style.width = Math.max(0, p.hp / p.maxHp * 100) + '%';
  document.getElementById('lvlText').textContent = `LVL ${p.level}`;
  document.getElementById('xpBar').style.width = (p.xp / p.xpNext * 100) + '%';
  document.getElementById('goldStat').textContent = `◈ ${G.gold} SHARDS`;
  document.getElementById('floorTag').textContent = `FLOOR ${String(G.floor).padStart(2, '0')}${G.floorModifier ? ` · ${G.floorModifier.name}` : ''}`;
  // player status chips
  const sc = document.getElementById('statusChips');
  if (sc) {
    const st = activeStatusList(p);
    sc.innerHTML = st.map((s) => `<span class="chip" style="border-color:${s.color};color:${s.color}">${s.icon} ${s.name}${s.stacks > 1 ? '×' + s.stacks : ''} <em>${s.t.toFixed(0)}s</em></span>`).join('');
  }
  // ability cooldowns
  p.abilities.forEach((ab, i) => {
    const el = document.getElementById('cd' + i);
    if (el) { const cd = ab.cd * Math.max(0.2, 1 - p.stats.cdr); el.style.transform = `scaleY(${Math.max(0, ab.cdLeft / cd)})`; }
  });
}

function renderAbilityBar() {
  const bar = document.getElementById('abilities');
  bar.innerHTML = '';
  const p = G.player;
  const keyLabels = ['J / LMB', 'L / RMB'];
  p.abilities.forEach((ab, i) => {
    const s = document.createElement('div');
    s.className = 'slot';
    s.style.borderColor = ab.color;
    s.style.setProperty('--slot-color', ab.color);
    const iconCell = HD_ABILITY_CELL[ab.shape] || [0, 0];
    s.innerHTML = `<span class="k">${keyLabels[i]||''}</span><span class="ability-art" style="background-position:${atlasPosition(iconCell[0],iconCell[1],6,3)}"></span><span class="nm">${ab.shapeName}</span><span class="cdfill" id="cd${i}" style="transform:scaleY(0)"></span>`;
    bar.appendChild(s);
  });
  if (p.abilities.length === 0) {
    const s = document.createElement('div'); s.className='slot'; s.style.setProperty('--slot-color', '#6fe3c4'); s.innerHTML=`<span class="k">J</span><span class="ability-art" style="background-position:${atlasPosition(2,0,6,3)}"></span><span class="nm">Strike</span>`; bar.appendChild(s);
  }
}

// ---------- inventory UI ----------
function toggleInv() {
  if (!G?.alive) return;
  const inv = document.getElementById('inv');
  const isOpen = inv.classList.toggle('open');
  G.paused = isOpen;
  if (isOpen) renderInv();
}
document.getElementById('closeInv').onclick = toggleInv;
// Destroy a single item → grant essence of its tier to the run tally.
function destroyItem(it) {
  const p = G.player;
  p.bag = p.bag.filter((x) => x !== it);
  const mul = G.upgradeEffects?.essenceMul || 1;
  const gain = Math.round((ESSENCE_YIELD[it.rarity] || 1) * mul);
  G.runEssence[it.rarity] = (G.runEssence[it.rarity] || 0) + gain;
  log(`Destroyed ${it.name} → +${gain} ${it.rarity} essence`, ESSENCE_COLOR[it.rarity]);
  renderInv();
}
// Destroy everything at or below a chosen tier in one click.
document.getElementById('sellJunk').onclick = () => {
  const p = G.player;
  const rank = { common:1, uncommon:2, rare:3, epic:4, legendary:5 };
  const mul = G.upgradeEffects?.essenceMul || 1;
  const bonusEvery = G.upgradeEffects?.salvageBonusEvery || 0;   // Greed: +1 per 3 junk items
  const keep = [];
  let total = 0;
  let junkCount = 0;
  for (const it of p.bag) {
    if (rank[it.rarity] <= 2) {   // common + uncommon
      const gain = Math.round((ESSENCE_YIELD[it.rarity] || 1) * mul);
      G.runEssence[it.rarity] = (G.runEssence[it.rarity] || 0) + gain;
      total += gain;
      junkCount++;
    } else keep.push(it);
  }
  if (bonusEvery > 0 && junkCount >= bonusEvery) {
    const bonus = Math.floor(junkCount / bonusEvery);
    G.runEssence.common = (G.runEssence.common || 0) + bonus;
    total += bonus;
  }
  p.bag = keep;
  if (total) log(`Salvaged junk → +${total} essence`, 'var(--accent)');
  renderInv();
};

const SLOT_ORDER = [['weapon','Weapon'],['weapon2','Off-hand'],['armor','Armor'],['trinket','Trinket']];
function renderInv() {
  const p = G.player;
  const eqList = document.getElementById('equipList'); eqList.innerHTML = '';
  for (const [slot, label] of SLOT_ORDER) {
    const it = p.equip[slot];
    const row = document.createElement('div'); row.className = 'equip-slot';
    const emptyText = slot === 'weapon2' ? '— empty (equip a 2nd weapon for a 2nd ability) —' : '— empty —';
    const equipCol = it ? (HD_ITEM_COL[it.base] ?? (it.slot === 'weapon' ? 1 : 5)) : (slot.startsWith('weapon') ? 1 : 5);
    row.innerHTML = `<span class="slotname">${label}</span><span class="equip-art${it?'':' empty'}" style="background-position:${atlasPosition(equipCol,2,6,3)}"></span><span class="iname" style="color:${it?it.rarityColor:'var(--dim)'};font-size:${it?'13px':'11px'}">${it?it.name:emptyText}</span>`;
    if (it) { attachTip(row, it); row.onclick = () => { unequip(slot); renderInv(); }; }
    eqList.appendChild(row);
  }
  // char stats
  const s = p.stats;
  document.getElementById('charStats').innerHTML = [
    `Max HP: ${s.maxHp}`, `Armor: ${s.armor}`, `Crit: ${Math.round(s.critChance*100)}% (x${(1.5+s.critDmg).toFixed(1)})`,
    `Lifesteal: ${Math.round(s.lifesteal*100)}%`, `Move Speed: +${Math.round(s.moveSpeed*100)}%`,
    `Dodge: ${Math.round(s.dodge*100)}%`, `Cooldown Red.: ${Math.round(s.cdr*100)}%`,
    `Ability Power: +${Math.round(s.abilityPower*100)}%`, `Ability Area: +${Math.round(s.area*100)}%`,
    `Attack Speed: +${Math.round(s.attackSpeed*100)}%`, `Block: ${Math.round(s.blockChance*100)}%`,
    `Loot Luck: +${Math.round(s.luck*100)}%`, `Thorns: ${Math.round(s.thorns)}`,
  ].map((x) => `<div>${x}</div>`).join('');

  const bag = document.getElementById('bag'); bag.innerHTML = '';
  document.getElementById('bagCount').textContent = p.bag.length;
  // run essence summary
  const es = document.getElementById('runEssence');
  if (es) {
    const parts = ESSENCE_TIERS.filter((t) => G.runEssence[t] > 0)
      .map((t) => `<span style="color:${ESSENCE_COLOR[t]}">${G.runEssence[t]} ${t}</span>`);
    es.innerHTML = parts.length ? `This run: ${parts.join(' · ')}` : 'This run: no essence yet — destroy items to collect it';
  }
  // sort: rarity then ilvl
  const order = { legendary:5, epic:4, rare:3, uncommon:2, common:1 };
  [...p.bag].sort((a,b)=> (order[b.rarity]-order[a.rarity])||(b.ilvl-a.ilvl)).forEach((it) => {
    const c = document.createElement('div'); c.className='itemcard'; c.style.borderColor = it.rarityColor + '55';
    const affLines = it.affixes.map((a)=>`<div class="aff">${a.label}</div>`).join('');
    const abLine = it.ability ? `<div class="ab">✦ ${it.ability.name} — ${it.ability.desc}</div>` : '';
    const defLine = it.defense ? `<div class="ab" style="color:#8fd1ff">🛡 ${it.defense.name} — ${it.defense.desc}</div>` : '';
    const dmg = it.stats.dmgHi ? `<span class="tp">${it.stats.dmgLo}-${it.stats.dmgHi} dmg</span>` : it.stats.armor ? `<span class="tp">${it.stats.armor} armor</span>` : `<span class="tp">${it.rarityName}</span>`;
    const ess = ESSENCE_YIELD[it.rarity] || 1;
    const itemCol = HD_ITEM_COL[it.base] ?? (it.slot === 'weapon' ? 1 : 5);
    c.innerHTML = `<div class="item-layout"><span class="item-art" style="background-position:${atlasPosition(itemCol,2,6,3)}"></span><div class="item-copy"><div class="top"><span class="nm" style="color:${it.rarityColor}">${it.name}</span>${dmg}</div>${affLines}${abLine}${defLine}`
      + `<div class="cardbtns"><button class="ib equip">Equip</button><button class="ib destroy" title="Destroy for ${ess} ${it.rarity} essence">Destroy ✦${ess}</button></div></div></div>`;
    c.querySelector('.equip').onclick = (e) => { e.stopPropagation(); equipItem(it); renderInv(); };
    c.querySelector('.destroy').onclick = (e) => { e.stopPropagation(); destroyItem(it); };
    bag.appendChild(c);
  });
}

function equipItem(it) {
  const p = G.player;
  let slot;
  if (it.slot === 'weapon') {
    // First weapon -> main hand. If the off-hand is unlocked (Dual Wield Training)
    // and the main slot is full but off-hand empty, a second weapon goes there
    // (granting a second ability). Otherwise it replaces the main-hand weapon.
    if (!p.equip.weapon) slot = 'weapon';
    else if (p.offhandUnlocked && !p.equip.weapon2) slot = 'weapon2';
    else slot = 'weapon';
  } else {
    slot = it.slot;
  }
  // remove from bag
  p.bag = p.bag.filter((x) => x !== it);
  const prev = p.equip[slot];
  p.equip[slot] = it;
  if (prev) p.bag.push(prev);
  recomputeStats();
  renderAbilityBar();
  saveRun();
}
function unequip(slot) {
  const p = G.player;
  if (!p.equip[slot]) return;
  p.bag.push(p.equip[slot]);
  p.equip[slot] = null;
  recomputeStats(); renderAbilityBar();
}

// tooltip
const tip = document.getElementById('tooltip');
function attachTip(el, it) {
  el.onmouseenter = (e) => {
    tip.style.display = 'block';
    const aff = it.affixes.map((a)=>`<div class="tt-line">${a.label}</div>`).join('');
    const ab = it.ability ? `<div class="tt-ab">✦ ${it.ability.name}<br>${it.ability.desc}<br><span style="color:var(--dim)">CD ${it.ability.cd}s · ${it.ability.dmgTypeName}</span></div>` : '';
    const def = it.defense ? `<div class="tt-ab" style="color:#8fd1ff">🛡 ${it.defense.name}<br>${it.defense.desc}</div>` : '';
    const base = it.stats.dmgHi ? `${it.stats.dmgLo}-${it.stats.dmgHi} damage` : it.stats.armor ? `${it.stats.armor} armor` : it.slot;
    tip.innerHTML = `<div class="tt-name" style="color:${it.rarityColor}">${it.name}</div><div class="tt-sub">${it.rarityName} · ilvl ${it.ilvl} · ${base}</div>${aff}${ab}${def}`;
  };
  el.onmousemove = (e) => { tip.style.left = Math.min(e.clientX+14, window.innerWidth-270)+'px'; tip.style.top = (e.clientY+14)+'px'; };
  el.onmouseleave = () => { tip.style.display = 'none'; };
}

// ---------- menu ----------
async function loadScores() {
  try {
    const r = await fetch('/api/scores'); const rows = await r.json();
    const el = document.getElementById('scoreList');
    el.innerHTML = rows.length ? rows.map((s)=>`<div class="srow"><span>${escapeHtml(s.name)}</span><span><b>F${s.floor}</b> · Lv${s.level}</span></div>`).join('') : '<div class="srow">No descents yet — be the first.</div>';
  } catch { document.getElementById('scoreList').innerHTML = '<div class="srow">Leaderboard offline.</div>'; }
}
function escapeHtml(s){return String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

document.getElementById('startBtn').onclick = () => {
  const seed = document.getElementById('seedInput').value.trim() || Math.random().toString(36).slice(2, 10);
  const name = Account.username || 'Wanderer';
  // Deep-start: if the selector is showing and a deeper floor is chosen, begin there.
  let startFloor = 1;
  const dsRow = document.getElementById('deepStartRow');
  if (dsRow.style.display !== 'none') {
    startFloor = parseInt(document.getElementById('deepStartSelect').value, 10) || 1;
  }
  document.getElementById('menu').style.display = 'none';
  document.getElementById('log').innerHTML = '';
  Audio.ensure();
  newRun(seed, name, startFloor);
  saveRun();
};
document.getElementById('resumeBtn').onclick = async () => {
  const ok = await loadRun();
  if (ok) { Audio.ensure(); document.getElementById('menu').style.display = 'none'; }
};

// ---------- auth UI ----------
let authTab = 'login';
document.querySelectorAll('.authtab').forEach((el) => {
  el.onclick = () => {
    authTab = el.dataset.tab;
    document.querySelectorAll('.authtab').forEach((t) => t.classList.toggle('active', t === el));
    document.getElementById('authBtn').textContent = authTab === 'login' ? 'LOG IN' : 'CREATE ACCOUNT';
    document.getElementById('authError').textContent = '';
  };
});
document.getElementById('authBtn').onclick = async () => {
  const u = document.getElementById('authUser').value.trim();
  const pw = document.getElementById('authPass').value;
  const err = document.getElementById('authError');
  err.textContent = '';
  try {
    if (authTab === 'register') await apiRegister(u, pw);
    else await apiLogin(u, pw);
    renderAccount();
  } catch (e) { err.textContent = e.message; }
};
document.getElementById('logoutBtn').onclick = async () => { await apiLogout(); renderAccount(); };
// Enter in the auth fields submits.
['authUser', 'authPass'].forEach((id) => {
  document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('authBtn').click(); });
});
document.getElementById('extractLeaveBtn').onclick = () => extractLeave();
document.getElementById('extractContinueBtn').onclick = () => extractContinue();
document.getElementById('deathOkBtn').onclick = () => {
  document.getElementById('deathModal').style.display = 'none';
  document.getElementById('menu').style.display = 'flex';
  renderAccount(); loadScores();
};

// Swap between logged-in / logged-out panels and render the essence vault.
function renderAccount() {
  const authed = Account.authed;
  document.getElementById('authPanel').style.display = authed ? 'none' : 'block';
  document.getElementById('acctPanel').style.display = authed ? 'block' : 'none';
  if (authed) {
    document.getElementById('acctName').textContent = Account.username;
    const v = document.getElementById('vault');
    const e = Account.essence || {};
    v.innerHTML = `<div style="font-size:10px;letter-spacing:.1em;color:var(--dim);margin-bottom:4px">ESSENCE VAULT</div>` +
      ESSENCE_TIERS.map((t) => `<div class="vrow"><span style="color:${ESSENCE_COLOR[t]}">${t}</span><span>${e[t] || 0}</span></div>`).join('');
    // Deep-start selector: only shown if the account has unlocked deep-start floors.
    const eff = Account.effects();
    const row = document.getElementById('deepStartRow');
    const sel = document.getElementById('deepStartSelect');
    const chars = availableCharacters(Account.upgrades || {});
    if (!chars.some((c) => c.id === Account.selectedCharacter)) Account.setCharacter('wanderer');
    v.innerHTML += `<div style="font-size:10px;letter-spacing:.1em;color:var(--dim);margin:10px 0 4px">CHARACTER</div>` +
      `<select id="characterSelect" style="width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--ink);padding:9px 10px;border-radius:9px;font-family:inherit;font-size:12px">${chars.map((c) => `<option value="${c.id}" ${c.id === Account.selectedCharacter ? 'selected' : ''}>${c.icon} ${c.name} — ${c.desc}</option>`).join('')}</select>`;
    document.getElementById('characterSelect').onchange = (ev) => { Account.setCharacter(ev.target.value); renderAccount(); };
    if (eff.deepStarts.length) {
      row.style.display = 'block';
      const prev = sel.value;
      sel.innerHTML = `<option value="1">Floor 1 — start fresh</option>` +
        eff.deepStarts.map((f) => `<option value="${f}">Floor ${f} — deep start</option>`).join('');
      if (prev) sel.value = prev;   // keep selection across re-renders
    } else {
      row.style.display = 'none';
    }
  }
  // if the hub is open, refresh it too
  if (document.getElementById('hubModal').style.display === 'flex') renderHub();
}

// ---------- Vault of Power (upgrade hub) ----------
let hubTab = 'stats';
function openHub() {
  document.getElementById('hubModal').style.display = 'flex';
  renderHub();
}
function renderHub() {
  const levels = Account.upgrades || {};
  const ess = Account.essence || {};
  // essence balance strip
  document.getElementById('hubEssence').innerHTML = 'Essence — ' +
    ESSENCE_TIERS.map((t) => `<span style="color:${ESSENCE_COLOR[t]}">${ess[t] || 0} ${t}</span>`).join(' · ');
  // category tabs
  const tabs = document.getElementById('hubTabs');
  tabs.innerHTML = UPGRADE_CATEGORIES.map((c) =>
    `<span class="htab ${c.key === hubTab ? 'active' : ''}" data-cat="${c.key}">${c.name}</span>`).join('');
  tabs.querySelectorAll('.htab').forEach((el) => {
    el.onclick = () => { hubTab = el.dataset.cat; renderHub(); };
  });
  // upgrade cards for the active category
  const list = document.getElementById('hubList');
  const items = UPGRADES.filter((u) => u.category === hubTab);
  list.innerHTML = items.map((up) => {
    const lvl = levels[up.id] || 0;
    const maxed = lvl >= up.maxLevel;
    const price = nextCost(up, levels);
    const lockedByReq = up.requires && !(levels[up.requires] > 0);
    // affordability
    let afford = true;
    if (price) for (const [t, amt] of Object.entries(price)) if ((ess[t] || 0) < amt) afford = false;
    const costTxt = price
      ? Object.entries(price).map(([t, amt]) => `<span style="color:${ESSENCE_COLOR[t]}">${amt} ${t}</span>`).join(' ')
      : '';
    const lvlTxt = up.maxLevel > 1 ? `LVL ${lvl}/${up.maxLevel}` : (lvl > 0 ? 'OWNED' : '');
    let btn;
    if (maxed) btn = `<button disabled>${up.maxLevel > 1 ? 'MAXED' : 'OWNED'}</button>`;
    else if (lockedByReq) btn = `<button disabled>Locked</button>`;
    else btn = `<button data-buy="${up.id}" ${afford ? '' : 'disabled'}>Buy</button>`;
    return `<div class="upcard ${maxed ? 'maxed' : ''}">
      <div class="upicon">${up.icon}</div>
      <div class="upinfo">
        <div class="upname">${up.name}</div>
        <div class="updesc">${up.desc}${lockedByReq ? ' <span style="color:var(--danger)">(requires previous tier)</span>' : ''}</div>
        ${lvlTxt ? `<div class="uplvl">${lvlTxt}</div>` : ''}
      </div>
      <div class="upbuy">
        ${costTxt ? `<div class="upcost">${costTxt}</div>` : ''}
        ${btn}
      </div>
    </div>`;
  }).join('');
  // wire buy buttons
  list.querySelectorAll('button[data-buy]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await apiBuyUpgrade(b.dataset.buy); renderHub(); renderAccount(); }
      catch (e) { b.disabled = false; document.getElementById('hubEssence').innerHTML =
        `<span style="color:var(--danger)">${e.message}</span>`; setTimeout(renderHub, 1200); }
    };
  });
}
document.getElementById('hubBtn').onclick = openHub;
document.getElementById('hubClose').onclick = () => { document.getElementById('hubModal').style.display = 'none'; };

// ---------- boot ----------
resize();
Audio.updateButton();
const audioToggle = document.getElementById('audioToggle');
if (audioToggle) audioToggle.onclick = () => Audio.toggle();
loadScores();
(async () => { await apiMe(); renderAccount(); })();  // restore session if token valid
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (G && G.alive && !G.paused) { update(dt); draw(); }
  else if (G && G.alive) { draw(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// autosave every 20s
setInterval(() => { if (G && G.alive && !G.paused) saveRun(); }, 20000);
