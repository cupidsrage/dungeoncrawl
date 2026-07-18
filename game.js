import {
  makeRNG, hashSeed, subSeed, generateDungeon, generateMonsters, generateItem,
  starterWeapon, MAP_W, MAP_H, T, STATUS, ESSENCE_TIERS, ESSENCE_YIELD, ESSENCE_COLOR,
} from './gen.js?v=5';
import { buildSprites, sprites, frameFor } from './sprites.js?v=5';

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
    hero: { frames: [solid(36, 36, '#e7e3d4'), solid(36, 36, '#e7e3d4')] },
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
  get authed() { return !!this.token; },
  headers() { return this.token ? { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }; },
  set(token, account) {
    this.token = token; this.username = account.username; this.essence = account.essence;
    localStorage.setItem('seedspire_token', token);
  },
  clear() { this.token = null; this.username = null; this.essence = null; localStorage.removeItem('seedspire_token'); },
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
  Account.username = data.account.username; Account.essence = data.account.essence;
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
const DPR = Math.min(window.devicePixelRatio || 1, 2);

// ---------- game state ----------
let G = null; // whole run state
const keys = {};
let mouse = { x: 0, y: 0, down: false, right: false };

function resize() {
  const cw = VIEW_TILES_X * TILE, ch = VIEW_TILES_Y * TILE;
  cv.width = cw * DPR; cv.height = ch * DPR;
  const scale = Math.min(window.innerWidth / cw, window.innerHeight / ch);
  cv.style.width = cw * scale + 'px';
  cv.style.height = ch * scale + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener('resize', resize);

// ---------- character math ----------
function recomputeStats() {
  const p = G.player;
  const eq = Object.values(p.equip).filter(Boolean);
  const s = { maxHp: 100, armor: 0, critChance: 0.05, critDmg: 0.5, lifesteal: 0, moveSpeed: 0,
    dodge: 0, regen: 0.25, cdr: 0, flatDmg: 0, fireDmg: 0, coldDmg: 0, lightningDmg: 0 };
  s.maxHp += (p.level - 1) * 10;
  for (const it of eq) for (const [k, v] of Object.entries(it.stats)) {
    if (s[k] != null && !['dmgLo', 'dmgHi', 'spd'].includes(k)) s[k] += v;
  }
  p.stats = s;
  p.maxHp = s.maxHp;
  if (p.hp > p.maxHp) p.hp = p.maxHp;
  // Abilities come from equipped weapon(s): main weapon + trinket-granted if any.
  p.abilities = [];
  if (p.equip.weapon?.ability) p.abilities.push({ ...p.equip.weapon.ability, cdLeft: 0, weapon: p.equip.weapon });
  if (p.equip.weapon2?.ability) p.abilities.push({ ...p.equip.weapon2.ability, cdLeft: 0, weapon: p.equip.weapon2 });
}

function weaponDamage() {
  const w = G.player.equip.weapon;
  const s = G.player.stats;
  let base = w ? (G.rng.int(w.stats.dmgLo, w.stats.dmgHi)) : G.rng.int(2, 4);
  base += s.flatDmg + s.fireDmg + s.coldDmg + s.lightningDmg;
  return base;
}

// ---------- run setup ----------
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
  }));
  G.drops = [];       // ground loot {x,y,item}
  G.projectiles = [];   // player projectiles
  G.eproj = [];         // enemy projectiles
  G.effects = [];
  G.pickups = [];     // gold/hp orbs
  // Place player at entry.
  G.player.px = (d.entry.x + 0.5) * TILE;
  G.player.py = (d.entry.y + 0.5) * TILE;
  log(`You enter floor ${floor}.`, floor % 5 === 0 ? 'var(--danger)' : 'var(--dim)');
  if (floor % 5 === 0) log('Something vast stirs below.', 'var(--danger)');
}

function newRun(seed, name) {
  const numericSeed = hashSeed(seed);
  G = {
    id: null, seed, name: name || 'Wanderer',
    rng: makeRNG(numericSeed ^ 0x9e3779b9),
    floor: 1, floorsCleared: 0, gold: 0, killCount: 0,
    runEssence: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 },  // banked at extract/death
    player: {
      px: 0, py: 0, hp: 100, maxHp: 100, level: 1, xp: 0, xpNext: 20,
      dir: { x: 0, y: 1 }, dashCd: 0, invuln: 0, hitFlash: 0,
      equip: { weapon: starterWeapon(seed), weapon2: null, armor: null, trinket: null },
      bag: [], stats: {}, abilities: [],
    },
    grid: null, rooms: [], monsters: [], drops: [], projectiles: [], effects: [], pickups: [],
    lastTime: 0, alive: true,
  };
  recomputeStats();
  G.player.hp = G.player.maxHp;
  buildFloor(1);
  renderAbilityBar();
}

// ---------- persistence ----------
async function saveRun() {
  if (!G) return;
  const state = {
    floor: G.floor, gold: G.gold, killCount: G.killCount, floorsCleared: G.floorsCleared,
    player: {
      hp: G.player.hp, level: G.player.level, xp: G.player.xp, xpNext: G.player.xpNext,
      equip: G.player.equip, bag: G.player.bag,
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
      equip: state.player.equip, bag: state.player.bag,
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
  const r = 6;
  for (const [ox, oy] of [[-r,-r],[r,-r],[-r,r],[r,r]]) {
    if (isWall(Math.floor((px + ox) / TILE), Math.floor((py + oy) / TILE))) return false;
  }
  return true;
}

// ---------- combat ----------
function fireAbility(idx, tx, ty) {
  const p = G.player;
  const ab = p.abilities[idx];
  if (!ab || ab.cdLeft > 0) return;
  if (isSilenced(p)) return;                 // frozen/stunned can't cast
  const dx = tx - p.px, dy = ty - p.py;
  const ang = Math.atan2(dy, dx);
  const cd = ab.cd * (1 - p.stats.cdr);
  ab.cdLeft = cd;
  const dmgBase = ab.power + Math.floor(weaponDamage() * 0.5);
  const mk = (a) => ({
    x: p.px, y: p.py, vx: Math.cos(a) * 240, vy: Math.sin(a) * 240,
    life: ab.range * TILE / 240, color: ab.color, dmg: dmgBase, dtype: ab.dmgType,
    pierce: ab.pierce, chain: ab.chain, hitSet: new Set(),
    lifesteal: ab.lifesteal, onHit: ab.onHit, r: 4,
  });

  if (ab.aoe && ab.shape === 'nova') {
    for (let i = 0; i < 12; i++) G.projectiles.push(mk((i / 12) * Math.PI * 2));
    G.effects.push({ type: 'ring', x: p.px, y: p.py, r: 0, maxR: ab.range * TILE, life: .35, t: 0, color: ab.color });
  } else if (ab.shape === 'cleave') {
    for (let i = -2; i <= 2; i++) G.projectiles.push(Object.assign(mk(ang + i * 0.22), { life: 0.18, vx: Math.cos(ang + i * 0.22) * 200, vy: Math.sin(ang + i * 0.22) * 200 }));
    G.effects.push({ type: 'arc', x: p.px, y: p.py, ang, life: .2, t: 0, color: ab.color });
  } else if (ab.multi > 1) {
    for (let i = 0; i < ab.multi; i++) { const a = ang + (i - (ab.multi - 1) / 2) * 0.16; G.projectiles.push(mk(a)); }
  } else {
    G.projectiles.push(mk(ang));
  }
  // self-buff on cast
  if (ab.selfBuff) { applyStatus(p, ab.selfBuff.status, ab.selfBuff.dur, 1); log(`${STATUS[ab.selfBuff.status].name}!`, STATUS[ab.selfBuff.status].color); }
  screenShake(ab.aoe ? 4 : 2);
}

function meleeSwing() {
  const p = G.player;
  if (p.swingCd > 0) return;
  p.swingCd = (p.equip.weapon?.stats.spd ? 0.5 / p.equip.weapon.stats.spd : 0.5);
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
  let dmg = amount * statusMul(p, 'dmgDealtMul');      // player Weaken/Rage
  dmg *= statusMul(m, 'dmgTakenMul');                   // target Vulnerable/Fortify
  const crit = G.rng.chance(p.stats.critChance);
  if (crit) dmg = Math.round(dmg * (1.5 + p.stats.critDmg));
  dmg = Math.round(dmg);
  m.hp -= dmg;
  m.hitFlash = 0.15;
  m.aggro = true;
  if (p.stats.lifesteal > 0) { p.hp = Math.min(p.maxHp, p.hp + dmg * p.stats.lifesteal); }
  // apply a status the hit carries (from the ability's damage type)
  if (onHit && G.rng.chance(onHit.chance)) applyStatus(m, onHit.status, onHit.dur, 1);
  spawnDamageNumber(m.fx * TILE + TILE / 2, m.fy * TILE + TILE / 2, dmg, crit, dtype);
  if (m.hp <= 0) killMonster(m);
}

function killMonster(m) {
  G.monsters = G.monsters.filter((x) => x !== m);
  G.killCount++;
  gainXp(m.xp);
  // loot roll
  const dropChance = m.boss ? 1 : 0.35;
  if (G.rng.chance(dropChance)) {
    const item = generateItem(G.seed, `f${G.floor}_${m.id}_${G.killCount}`, G.floor, m.boss ? 1.5 : 0.2);
    G.drops.push({ x: m.fx, y: m.fy, item, fx: m.fx, fy: m.fy });
  }
  // gold + hp orbs (healing is scarcer now — you're meant to feel attrition)
  const gold = G.rng.int(2, 6) + G.floor;
  G.pickups.push({ x: m.fx, y: m.fy, type: 'gold', amt: gold });
  if (G.rng.chance(0.10)) G.pickups.push({ x: m.fx + 0.3, y: m.fy, type: 'hp', amt: 5 + Math.floor(G.floor * 0.4) });
  if (m.boss) { log(`${m.name} falls!`, 'var(--gold)'); screenShake(10); }
}

function damagePlayer(amount, incomingStatus = null) {
  const p = G.player;
  if (p.invuln > 0) return;
  if (G.rng.chance(p.stats.dodge)) { spawnDamageNumber(p.px, p.py, 'dodge', false, 'text'); return; }
  // Shield buff absorbs one hit entirely.
  if (hasStatus(p, 'shield')) { delete p.fx_status.shield; spawnDamageNumber(p.px, p.py, 'block', false, 'text'); p.invuln = 0.3; return; }
  let dmg = amount * (100 / (100 + p.stats.armor));
  dmg *= statusMul(p, 'dmgTakenMul');                  // Fortify (down) / Vulnerable (up)
  p.hp -= dmg;
  p.hitFlash = 0.2; p.invuln = 0.25;
  if (incomingStatus && G.rng.chance(incomingStatus.chance ?? 1)) applyStatus(p, incomingStatus.status, incomingStatus.dur, 1);
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
    });
  }
  G.effects.push({ type: 'hit', x: mx, y: my, life: .15, t: 0, color });
}

// ---------- monster AI ----------
function updateMonsters(dt) {
  const p = G.player;
  rebuildFlowField();   // one shared BFS from the player; all mobs path off it
  // periodic flank reassignment so the group re-spaces as you move
  G.flankTick = (G.flankTick || 0) - dt;
  if (G.flankTick <= 0) { assignFlankSlots(); G.flankTick = 1.5; }

  for (const m of G.monsters) {
    const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
    const dist = Math.hypot(p.px - mx, p.py - my);
    const los = hasLOS(mx, my, p.px, p.py);
    if (m.hitFlash > 0) m.hitFlash -= dt;
    if (m.telegraph > 0) m.telegraph -= dt;
    if (m.atkCd > 0) m.atkCd -= dt;
    // Aggro on sight OR proximity; once aggroed, stays (hunts via flow field).
    if ((dist < 260 && los) || dist < 130) m.aggro = true;

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
        if (!silenced && (m.behavior === 'caster' || m.behavior === 'bomber' || m.behavior === 'warden')
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
          if (m.telegraph > 0 && m.telegraph - dt <= 0 && los && !silenced) {
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
        case 'boss': {
          if (dist > 40) pathToPlayer(m, spd, dt);
          if (!silenced && m.atkCd <= 0 && los) { if (dist < 360) enemyShoot(m, mx, my, { count: 5, spread: 0.30, speed: 210 }); m.atkCd = 1.4; }
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
            if (m.telegraph > 0 && m.telegraph - dt <= 0 && !silenced) {
              if (m.telegraphKind === 'toss') {
                // heavy slow-moving boulder: earthy, big, applies a strong slow so
                // the lumbering brute can close the distance on a fleeing player
                enemyShoot(m, mx, my, {
                  speed: 135, life: 2.6, dmgMul: 0.8, r: 9, color: '#a88b63',
                  onHit: { status: 'slow', chance: 1, dur: 2.0 },
                });
              } else if (m.telegraphKind === 'slam' && dist < 75) {
                // big earthquake: wide radius, heavy hit, screen shake
                damagePlayer(Math.round(m.dmg * 1.9));
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

    // melee contact damage
    if (dist < 18 && m.behavior !== 'boss') {
      if ((m.touchCd = (m.touchCd || 0) - dt) <= 0) {
        damagePlayer(m.behavior === 'charger' && m.chargeState === 'dash' ? Math.round(m.dmg * 1.6) : m.dmg);
        m.touchCd = 0.5;
      }
    } else if (dist < 20 && m.boss) {
      if ((m.touchCd = (m.touchCd || 0) - dt) <= 0) { damagePlayer(m.dmg); m.touchCd = 0.45; }
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
      damagePlayer(pr.dmg, pr.onHit);
      G.effects.push({ type: 'hit', x: pr.x, y: pr.y, life: .18, t: 0, color: pr.color });
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
        if (pr.lifesteal) p.hp = Math.min(p.maxHp, p.hp + pr.dmg * pr.lifesteal);
        G.effects.push({ type: 'hit', x: pr.x, y: pr.y, life: .18, t: 0, color: pr.color });
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

// ---------- pickups / loot ----------
function updatePickups() {
  const p = G.player;
  for (const pu of G.pickups) {
    const px = pu.x * TILE + TILE / 2, py = pu.y * TILE + TILE / 2;
    if (Math.hypot(px - p.px, py - p.py) < 22) {
      if (pu.type === 'gold') { G.gold += pu.amt; }
      else if (pu.type === 'hp') { p.hp = Math.min(p.maxHp, p.hp + pu.amt); }
      pu.dead = true;
    }
  }
  G.pickups = G.pickups.filter((x) => !x.dead);

  for (const d of G.drops) {
    const dx = d.x * TILE + TILE / 2, dy = d.y * TILE + TILE / 2;
    if (Math.hypot(dx - p.px, dy - p.py) < 20) {
      G.player.bag.push(d.item);
      log(`Picked up ${d.item.name}`, d.item.rarityColor);
      d.dead = true;
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
      ctx.drawImage(SPR.floor[variant], sx, sy, TILE, TILE);
      if (cell === T.STAIRS) { const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 300); ctx.globalAlpha = pulse; ctx.drawImage(SPR.stairs, sx, sy, TILE, TILE); ctx.globalAlpha = 1; }
      if (cell === T.ENTRY) ctx.drawImage(SPR.entry, sx, sy, TILE, TILE);
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
      ctx.drawImage(SPR.wall, sx, sy, TILE, TILE);
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
    // gem
    ctx.shadowColor=col; ctx.shadowBlur=10;
    ctx.fillStyle=col;
    ctx.beginPath();
    ctx.moveTo(sx, sy-5+bob); ctx.lineTo(sx+4, sy+bob); ctx.lineTo(sx, sy+5+bob); ctx.lineTo(sx-4, sy+bob); ctx.closePath();
    ctx.fill();
    ctx.shadowBlur=0;
    // facet highlight
    ctx.fillStyle='rgba(255,255,255,.6)'; ctx.beginPath(); ctx.moveTo(sx,sy-5+bob); ctx.lineTo(sx+2,sy-1+bob); ctx.lineTo(sx,sy+bob); ctx.closePath(); ctx.fill();
  }

  // monsters
  for (const m of G.monsters) {
    const sx=Math.round(m.fx*TILE+TILE/2-camX), sy=Math.round(m.fy*TILE+TILE/2-camY);
    const sprObj = SPR.mob[m.key] || SPR.mob.grub;
    const spr = frameFor(sprObj, m.fx * 0.7);   // phase by position so they don't sync
    const dw = m.boss ? 54 : 36, dh = dw;
    const bob = Math.sin(Date.now()/220 + m.fx) * 1.2;   // idle bob
    // telegraph flash before a special attack — the player's cue to react
    if (m.telegraph > 0) {
      if (m.telegraphKind === 'slam') {
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
    // face the player: flip horizontally if player is to the left
    const faceLeft = G.player.px < (m.fx*TILE+TILE/2);
    ctx.save();
    ctx.translate(sx, sy + bob);
    if (faceLeft) ctx.scale(-1, 1);
    ctx.drawImage(spr, -dw/2, -dh/2, dw, dh);
    ctx.restore();
    ctx.shadowBlur = 0;
    // hit flash: white silhouette overlay using the sprite as a mask
    if (m.hitFlash > 0) {
      ctx.save(); ctx.globalAlpha = m.hitFlash / 0.15 * 0.8; ctx.globalCompositeOperation = 'lighter';
      ctx.translate(sx, sy + bob); if (faceLeft) ctx.scale(-1,1);
      ctx.drawImage(spr, -dw/2, -dh/2, dw, dh);
      ctx.restore();
    }
    // hp bar
    if (m.hp < m.maxHp) { const bw = dw*0.5; ctx.fillStyle='#2a0f16'; ctx.fillRect(sx-bw,sy-dh/2-2,bw*2,3); ctx.fillStyle='#ff4b5c'; ctx.fillRect(sx-bw,sy-dh/2-2,bw*2*(m.hp/m.maxHp),3); }
    // status pips
    const st = activeStatusList(m);
    if (st.length) st.slice(0,4).forEach((s,i)=>{ ctx.fillStyle=s.color; ctx.beginPath(); ctx.arc(sx-dw*0.4+i*6, sy-dh/2-7, 2.4, 0, 7); ctx.fill(); });
    // frozen tint
    if (hasStatus(m,'freeze')) { ctx.fillStyle='rgba(120,210,255,.4)'; ctx.save(); ctx.translate(sx,sy+bob); if(faceLeft)ctx.scale(-1,1); ctx.globalCompositeOperation='source-atop'; ctx.drawImage(spr,-dw/2,-dh/2,dw,dh); ctx.restore(); }
  }

  // projectiles (player)
  for (const pr of G.projectiles) {
    const sx=pr.x-camX, sy=pr.y-camY;
    ctx.shadowColor=pr.color; ctx.shadowBlur=8; ctx.fillStyle=pr.color;
    ctx.beginPath(); ctx.arc(sx,sy,4,0,7); ctx.fill(); ctx.shadowBlur=0;
  }
  // projectiles (enemy) — drawn with a dark core so they read as incoming threats
  for (const pr of G.eproj) {
    const sx=pr.x-camX, sy=pr.y-camY;
    ctx.shadowColor=pr.color; ctx.shadowBlur=9; ctx.fillStyle=pr.color;
    ctx.beginPath(); ctx.arc(sx,sy,pr.r,0,7); ctx.fill();
    ctx.shadowBlur=0; ctx.fillStyle='rgba(0,0,0,.45)';
    ctx.beginPath(); ctx.arc(sx,sy,pr.r*0.45,0,7); ctx.fill();
  }

  // effects
  for (const e of G.effects) drawEffect(e, camX, camY);

  // player
  const psx=Math.round(p.px-camX), psy=Math.round(p.py-camY);
  if (p.invuln>0 && Math.floor(Date.now()/60)%2) {} else {
    const bob = Math.sin(Date.now()/200) * 1;
    ctx.shadowColor = p.dashT>0 ? '#6fe3c4' : (hasStatus(p,'rage') ? '#ff5d6c' : '#6fe3c4');
    ctx.shadowBlur = p.dashT>0 ? 16 : 5;
    const faceLeft = p.dir.x < -0.1;
    const hspr = frameFor(SPR.hero, p.moving ? Date.now()/60 : 0);  // faster stride while moving
    ctx.save(); ctx.translate(psx, psy + bob); if (faceLeft) ctx.scale(-1,1);
    ctx.drawImage(hspr, -18, -20, 36, 36);
    ctx.restore(); ctx.shadowBlur = 0;
    // hit flash
    if (p.hitFlash > 0) { ctx.save(); ctx.globalAlpha = p.hitFlash/0.2*0.7; ctx.globalCompositeOperation='lighter'; ctx.translate(psx,psy+bob); if(faceLeft)ctx.scale(-1,1); ctx.drawImage(hspr,-18,-20,36,36); ctx.restore(); }
    // small facing dot toward aim
    ctx.fillStyle='#6fe3c4'; ctx.globalAlpha=.8; ctx.beginPath(); ctx.arc(psx+p.dir.x*11, psy+p.dir.y*11, 2, 0, 7); ctx.fill(); ctx.globalAlpha=1;
    // shield buff ring
    if (hasStatus(p,'shield')) { ctx.strokeStyle='#8fd1ff'; ctx.lineWidth=1.5; ctx.globalAlpha=.7; ctx.beginPath(); ctx.arc(psx,psy,14,0,7); ctx.stroke(); ctx.globalAlpha=1; }
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

  // vignette
  const grad=ctx.createRadialGradient(VIEW_TILES_X*TILE/2,VIEW_TILES_Y*TILE/2,120,VIEW_TILES_X*TILE/2,VIEW_TILES_Y*TILE/2,420);
  grad.addColorStop(0,'rgba(0,0,0,0)'); grad.addColorStop(1,'rgba(0,0,0,.55)');
  ctx.fillStyle=grad; ctx.fillRect(0,0,VIEW_TILES_X*TILE,VIEW_TILES_Y*TILE);
}

function drawEffect(e, camX, camY) {
  const sx=e.x-camX, sy=e.y-camY, prog=e.t/e.life;
  ctx.globalAlpha=1-prog;
  if (e.type==='ring'){ ctx.strokeStyle=e.color; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(sx,sy,prog*e.maxR,0,7); ctx.stroke(); }
  else if (e.type==='hit'){ ctx.fillStyle=e.color; ctx.beginPath(); ctx.arc(sx,sy,6*(1-prog)+2,0,7); ctx.fill(); }
  else if (e.type==='swing'||e.type==='arc'){ ctx.strokeStyle=e.color; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(sx,sy,26,e.ang-0.8,e.ang+0.8); ctx.stroke(); }
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
  document.getElementById('goldStat').textContent = `◈ ${G.gold}`;
  document.getElementById('floorTag').textContent = `FLOOR ${G.floor}`;
  // player status chips
  const sc = document.getElementById('statusChips');
  if (sc) {
    const st = activeStatusList(p);
    sc.innerHTML = st.map((s) => `<span class="chip" style="border-color:${s.color};color:${s.color}">${s.icon} ${s.name}${s.stacks > 1 ? '×' + s.stacks : ''} <em>${s.t.toFixed(0)}s</em></span>`).join('');
  }
  // ability cooldowns
  p.abilities.forEach((ab, i) => {
    const el = document.getElementById('cd' + i);
    if (el) { const cd = ab.cd * (1 - p.stats.cdr); el.style.transform = `scaleY(${Math.max(0, ab.cdLeft / cd)})`; }
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
    s.innerHTML = `<span class="k">${keyLabels[i]||''}</span><span class="nm">${ab.shapeName}</span><span class="cdfill" id="cd${i}" style="transform:scaleY(0)"></span>`;
    bar.appendChild(s);
  });
  if (p.abilities.length === 0) {
    const s = document.createElement('div'); s.className='slot'; s.innerHTML='<span class="k">J</span><span class="nm">Strike</span>'; bar.appendChild(s);
  }
}

// ---------- inventory UI ----------
function toggleInv() {
  const inv = document.getElementById('inv');
  inv.classList.toggle('open');
  if (inv.classList.contains('open')) renderInv();
}
document.getElementById('closeInv').onclick = toggleInv;
// Destroy a single item → grant essence of its tier to the run tally.
function destroyItem(it) {
  const p = G.player;
  p.bag = p.bag.filter((x) => x !== it);
  const gain = ESSENCE_YIELD[it.rarity] || 1;
  G.runEssence[it.rarity] = (G.runEssence[it.rarity] || 0) + gain;
  log(`Destroyed ${it.name} → +${gain} ${it.rarity} essence`, ESSENCE_COLOR[it.rarity]);
  renderInv();
}
// Destroy everything at or below a chosen tier in one click.
document.getElementById('sellJunk').onclick = () => {
  const p = G.player;
  const rank = { common:1, uncommon:2, rare:3, epic:4, legendary:5 };
  const keep = [];
  let total = 0;
  for (const it of p.bag) {
    if (rank[it.rarity] <= 2) {   // common + uncommon
      const gain = ESSENCE_YIELD[it.rarity] || 1;
      G.runEssence[it.rarity] = (G.runEssence[it.rarity] || 0) + gain;
      total += gain;
    } else keep.push(it);
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
    row.innerHTML = `<span class="slotname">${label}</span><span class="iname" style="color:${it?it.rarityColor:'var(--dim)'};font-size:${it?'13px':'11px'}">${it?it.name:emptyText}</span>`;
    if (it) { attachTip(row, it); row.onclick = () => { unequip(slot); renderInv(); }; }
    eqList.appendChild(row);
  }
  // char stats
  const s = p.stats;
  document.getElementById('charStats').innerHTML = [
    `Max HP: ${s.maxHp}`, `Armor: ${s.armor}`, `Crit: ${Math.round(s.critChance*100)}% (x${(1.5+s.critDmg).toFixed(1)})`,
    `Lifesteal: ${Math.round(s.lifesteal*100)}%`, `Move Speed: +${Math.round(s.moveSpeed*100)}%`,
    `Dodge: ${Math.round(s.dodge*100)}%`, `Cooldown Red.: ${Math.round(s.cdr*100)}%`,
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
    const dmg = it.stats.dmgHi ? `<span class="tp">${it.stats.dmgLo}-${it.stats.dmgHi} dmg</span>` : it.stats.armor ? `<span class="tp">${it.stats.armor} armor</span>` : `<span class="tp">${it.rarityName}</span>`;
    const ess = ESSENCE_YIELD[it.rarity] || 1;
    c.innerHTML = `<div class="top"><span class="nm" style="color:${it.rarityColor}">${it.name}</span>${dmg}</div>${affLines}${abLine}`
      + `<div class="cardbtns"><button class="ib equip">Equip</button><button class="ib destroy" title="Destroy for ${ess} ${it.rarity} essence">Destroy ✦${ess}</button></div>`;
    c.querySelector('.equip').onclick = (e) => { e.stopPropagation(); equipItem(it); renderInv(); };
    c.querySelector('.destroy').onclick = (e) => { e.stopPropagation(); destroyItem(it); };
    bag.appendChild(c);
  });
}

function equipItem(it) {
  const p = G.player;
  let slot;
  if (it.slot === 'weapon') {
    // First weapon -> main hand. If main is full and off-hand is empty, a second
    // weapon goes to the off-hand (granting a second ability). Otherwise it
    // replaces the main-hand weapon.
    if (!p.equip.weapon) slot = 'weapon';
    else if (!p.equip.weapon2) slot = 'weapon2';
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
    const base = it.stats.dmgHi ? `${it.stats.dmgLo}-${it.stats.dmgHi} damage` : it.stats.armor ? `${it.stats.armor} armor` : it.slot;
    tip.innerHTML = `<div class="tt-name" style="color:${it.rarityColor}">${it.name}</div><div class="tt-sub">${it.rarityName} · ilvl ${it.ilvl} · ${base}</div>${aff}${ab}`;
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
  document.getElementById('menu').style.display = 'none';
  document.getElementById('log').innerHTML = '';
  newRun(seed, name);
  saveRun();
};
document.getElementById('resumeBtn').onclick = async () => {
  const ok = await loadRun();
  if (ok) document.getElementById('menu').style.display = 'none';
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
  }
}

// ---------- boot ----------
resize();
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
