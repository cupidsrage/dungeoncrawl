import {
  makeRNG, hashSeed, subSeed, generateDungeon, generateMonsters, generateItem,
  starterWeapon, MAP_W, MAP_H, T,
} from './gen.js';

// ---------- constants ----------
const TILE = 20;              // world units per tile
const VIEW_TILES_X = 30, VIEW_TILES_Y = 20;
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const DPR = Math.min(window.devicePixelRatio || 1, 2);

// ---------- game state ----------
let G = null; // whole run state
const keys = {};
let mouse = { x: 0, y: 0, down: false };

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
    dodge: 0, regen: 1, cdr: 0, flatDmg: 0, fireDmg: 0, coldDmg: 0, lightningDmg: 0 };
  s.maxHp += (p.level - 1) * 12;
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
  G.monsters = generateMonsters(G.seed, floor, d.rooms).map((m) => ({ ...m, fx: m.x, fy: m.y, hitFlash: 0, aggro: false }));
  G.drops = [];       // ground loot {x,y,item}
  G.projectiles = [];
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
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (k === 'i') { e.preventDefault(); toggleInv(); }
  if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','j','k',' '].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

cv.addEventListener('mousemove', (e) => {
  const r = cv.getBoundingClientRect();
  mouse.x = (e.clientX - r.left) / r.width * (VIEW_TILES_X * TILE);
  mouse.y = (e.clientY - r.top) / r.height * (VIEW_TILES_Y * TILE);
});
cv.addEventListener('mousedown', () => { mouse.down = true; });
window.addEventListener('mouseup', () => { mouse.down = false; });

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
  const dx = tx - p.px, dy = ty - p.py;
  const ang = Math.atan2(dy, dx);
  const cd = ab.cd * (1 - p.stats.cdr);
  ab.cdLeft = cd;
  const dmgBase = ab.power + Math.floor(weaponDamage() * 0.5);
  const mk = (a) => ({
    x: p.px, y: p.py, vx: Math.cos(a) * 240, vy: Math.sin(a) * 240,
    life: ab.range * TILE / 240, color: ab.color, dmg: dmgBase, dtype: ab.dmgType,
    pierce: ab.pierce, chain: ab.chain, hitSet: new Set(), dot: ab.dot, slow: ab.slow,
    lifesteal: ab.lifesteal, r: ab.aoe ? 4 : 4,
  });

  if (ab.aoe && ab.shape === 'nova') {
    // ring: spawn projectiles in a circle
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

function damageMonster(m, amount, dtype) {
  const p = G.player;
  let dmg = amount;
  const crit = G.rng.chance(p.stats.critChance);
  if (crit) dmg = Math.round(dmg * (1.5 + p.stats.critDmg));
  m.hp -= dmg;
  m.hitFlash = 0.15;
  m.aggro = true;
  if (p.stats.lifesteal > 0) { p.hp = Math.min(p.maxHp, p.hp + dmg * p.stats.lifesteal); }
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
  // gold + hp orbs
  const gold = G.rng.int(2, 6) + G.floor;
  G.pickups.push({ x: m.fx, y: m.fy, type: 'gold', amt: gold });
  if (G.rng.chance(0.3)) G.pickups.push({ x: m.fx + 0.3, y: m.fy, type: 'hp', amt: 10 + G.floor });
  if (m.boss) { log(`${m.name} falls!`, 'var(--gold)'); screenShake(10); }
}

function damagePlayer(amount) {
  const p = G.player;
  if (p.invuln > 0) return;
  if (G.rng.chance(p.stats.dodge)) { spawnDamageNumber(p.px, p.py, 'dodge', false, 'text'); return; }
  const reduced = amount * (100 / (100 + p.stats.armor));
  p.hp -= reduced;
  p.hitFlash = 0.2; p.invuln = 0.4;
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
    p.hp = p.maxHp;
    log(`Level up! You are level ${p.level}.`, 'var(--accent)');
    G.effects.push({ type: 'levelup', x: p.px, y: p.py, life: .8, t: 0 });
  }
}

// ---------- monster AI ----------
function updateMonsters(dt) {
  const p = G.player;
  for (const m of G.monsters) {
    const mx = m.fx * TILE + TILE / 2, my = m.fy * TILE + TILE / 2;
    const dist = Math.hypot(p.px - mx, p.py - my);
    if (m.hitFlash > 0) m.hitFlash -= dt;
    if (dist < 160) m.aggro = true;
    if (m.aggro && dist > 4) {
      const slow = m.slowT > 0 ? 0.5 : 1;
      const spd = m.spd * 42 * dt * slow;
      const ang = Math.atan2(p.py - my, p.px - mx);
      const nx = mx + Math.cos(ang) * spd, ny = my + Math.sin(ang) * spd;
      // Move on each axis independently so monsters slide along walls instead of sticking.
      if (!isWall(Math.floor(nx / TILE), Math.floor(my / TILE))) m.fx = (nx - TILE / 2) / TILE;
      const cx = m.fx * TILE + TILE / 2;
      if (!isWall(Math.floor(cx / TILE), Math.floor(ny / TILE))) m.fy = (ny - TILE / 2) / TILE;
    }
    // attack on contact
    if (dist < 18) { m.atkCd = (m.atkCd || 0) - dt; if (m.atkCd <= 0) { damagePlayer(m.dmg); m.atkCd = 0.8; } }
    // status
    if (m.burn > 0) { m.burn -= dt; m.burnTick = (m.burnTick || 0) - dt; if (m.burnTick <= 0) { damageMonster(m, Math.max(1, Math.round(m.burnDmg)), 'fire'); m.burnTick = 0.5; } }
    if (m.slowT > 0) m.slowT -= dt;
  }
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
        let dmg = pr.dmg;
        if (m.slowT > 0) dmg = Math.round(dmg * 1.1);
        damageMonster(m, dmg, pr.dtype);
        if (pr.dot === 'burn') { m.burn = 2; m.burnDmg = pr.dmg * 0.15; }
        if (pr.slow) { m.slowT = 1.5; }
        if (pr.lifesteal) p.hp = Math.min(p.maxHp, p.hp + dmg * pr.lifesteal);
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
    G.floorsCleared++;
    buildFloor(G.floor + 1);
    saveRun();
  }
}

// ---------- game over ----------
async function gameOver() {
  G.alive = false;
  log('You have fallen.', 'var(--danger)');
  try {
    await fetch('/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: G.name, seed: G.seed, floor: G.floor, level: G.player.level }) });
  } catch {}
  setTimeout(() => {
    document.getElementById('menu').style.display = 'flex';
    loadScores();
  }, 1200);
}

// ---------- effects & juice ----------
let shake = 0;
function screenShake(a) { shake = Math.min(12, shake + a); }
const dmgNumbers = [];
function spawnDamageNumber(x, y, val, crit, dtype) {
  const colors = { phys: '#fff', fire: '#ff7a3c', cold: '#63c6ff', lightning: '#ffe14a', void: '#b46bff', text: '#7fe' };
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
  // timers
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.invuln > 0) p.invuln -= dt;
  if (p.dashCd > 0) p.dashCd -= dt;
  if (p.swingCd > 0) p.swingCd -= dt;
  for (const ab of p.abilities) if (ab.cdLeft > 0) ab.cdLeft -= dt;

  // movement
  let mx = 0, my = 0;
  if (keys['w'] || keys['arrowup']) my -= 1;
  if (keys['s'] || keys['arrowdown']) my += 1;
  if (keys['a'] || keys['arrowleft']) mx -= 1;
  if (keys['d'] || keys['arrowright']) mx += 1;
  mx += touchVec.x; my += touchVec.y;
  const mag = Math.hypot(mx, my);
  if (mag > 0) {
    mx /= mag; my /= mag;
    p.dir = { x: mx, y: my };
    const speed = 120 * (1 + p.stats.moveSpeed) * (p.dashT > 0 ? 2.4 : 1);
    const nx = p.px + mx * speed * dt, ny = p.py + my * speed * dt;
    if (canMove(nx, p.py)) p.px = nx;
    if (canMove(p.px, ny)) p.py = ny;
  }
  if (p.dashT > 0) p.dashT -= dt;
  // dash
  if ((keys['k'] || keys[' ']) && p.dashCd <= 0) { p.dashT = 0.16; p.dashCd = 1.2; p.invuln = 0.2; }

  // attacks
  const aimX = mouse.x - VIEW_TILES_X * TILE / 2 + p.px;
  const aimY = mouse.y - VIEW_TILES_Y * TILE / 2 + p.py;
  if (keys['j'] || mouse.down || firing) {
    // primary ability = ability[0] if present, else melee
    if (p.abilities[0]) fireAbility(0, aimX, aimY);
    else meleeSwing();
  }
  if (keys['l'] && p.abilities[1]) fireAbility(1, aimX, aimY);
  if (keys['u']) meleeSwing();

  updateMonsters(dt);
  updateProjectiles(dt);
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
  for (let ty = t0y - 1; ty <= t0y + VIEW_TILES_Y + 1; ty++) {
    for (let tx = t0x - 1; tx <= t0x + VIEW_TILES_X + 1; tx++) {
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) continue;
      const cell = G.grid[ty][tx];
      if (cell === T.WALL) continue;
      const sx = tx * TILE - camX, sy = ty * TILE - camY;
      ctx.fillStyle = ((tx + ty) & 1) ? '#1c2130' : '#20263a';
      ctx.fillRect(sx, sy, TILE, TILE);
      if (cell === T.STAIRS) { ctx.fillStyle = '#f0b341'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center'; ctx.fillText('▼', sx + TILE/2, sy + TILE/2 + 5); }
      if (cell === T.ENTRY) { ctx.fillStyle = '#6fe3c4'; ctx.font = '12px monospace'; ctx.textAlign = 'center'; ctx.fillText('△', sx + TILE/2, sy + TILE/2 + 4); }
    }
  }
  // subtle wall edges
  ctx.strokeStyle = 'rgba(0,0,0,.4)';
  for (let ty = t0y - 1; ty <= t0y + VIEW_TILES_Y + 1; ty++)
    for (let tx = t0x - 1; tx <= t0x + VIEW_TILES_X + 1; tx++) {
      if (tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) continue;
      if (G.grid[ty][tx] !== T.WALL) continue;
      // draw wall only where adjacent to floor (edge)
      let edge=false; for (const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) { const nx=tx+dx,ny=ty+dy; if(nx>=0&&ny>=0&&nx<MAP_W&&ny<MAP_H&&G.grid[ny][nx]!==T.WALL) edge=true; }
      if (!edge) continue;
      const sx = tx*TILE-camX, sy=ty*TILE-camY;
      ctx.fillStyle='#080a0f'; ctx.fillRect(sx,sy,TILE,TILE);
      ctx.fillStyle='#161b28'; ctx.fillRect(sx,sy,TILE,3);
    }

  // pickups
  for (const pu of G.pickups) {
    const sx = pu.x*TILE+TILE/2-camX, sy=pu.y*TILE+TILE/2-camY;
    ctx.beginPath();
    if (pu.type==='gold'){ctx.fillStyle='#f0b341';ctx.arc(sx,sy,3+Math.sin(Date.now()/200)*.6,0,7);}
    else {ctx.fillStyle='#ff5d6c';ctx.arc(sx,sy,4,0,7);}
    ctx.fill();
  }
  // drops (glowing loot)
  for (const d of G.drops) {
    const sx=d.x*TILE+TILE/2-camX, sy=d.y*TILE+TILE/2-camY;
    const glow=Math.sin(Date.now()/300)*1.5+3;
    ctx.shadowColor=d.item.rarityColor; ctx.shadowBlur=10;
    ctx.fillStyle=d.item.rarityColor;
    ctx.fillRect(sx-4,sy-4+Math.sin(Date.now()/400)*2,8,8);
    ctx.shadowBlur=0;
  }

  // monsters
  for (const m of G.monsters) {
    const sx=m.fx*TILE+TILE/2-camX, sy=m.fy*TILE+TILE/2-camY;
    ctx.fillStyle=m.hitFlash>0?'#fff':m.color;
    const size=m.boss?14:m.key==='brute'?11:8;
    ctx.beginPath(); ctx.arc(sx,sy,size,0,7); ctx.fill();
    ctx.fillStyle='#0b0d14'; ctx.font=`bold ${m.boss?14:10}px monospace`; ctx.textAlign='center';
    ctx.fillText(m.glyph, sx, sy+(m.boss?5:3));
    // hp bar
    if (m.hp < m.maxHp) { ctx.fillStyle='#2a0f16'; ctx.fillRect(sx-size,sy-size-6,size*2,3); ctx.fillStyle='#ff4b5c'; ctx.fillRect(sx-size,sy-size-6,size*2*(m.hp/m.maxHp),3); }
  }

  // projectiles
  for (const pr of G.projectiles) {
    const sx=pr.x-camX, sy=pr.y-camY;
    ctx.shadowColor=pr.color; ctx.shadowBlur=8; ctx.fillStyle=pr.color;
    ctx.beginPath(); ctx.arc(sx,sy,4,0,7); ctx.fill(); ctx.shadowBlur=0;
  }

  // effects
  for (const e of G.effects) drawEffect(e, camX, camY);

  // player
  const psx=p.px-camX, psy=p.py-camY;
  if (p.invuln>0 && Math.floor(Date.now()/60)%2) {} else {
    ctx.shadowColor='#6fe3c4'; ctx.shadowBlur=p.dashT>0?16:6;
    ctx.fillStyle=p.hitFlash>0?'#ff5d6c':'#e7e3d4';
    ctx.beginPath(); ctx.arc(psx,psy,7,0,7); ctx.fill(); ctx.shadowBlur=0;
    // facing marker
    ctx.fillStyle='#6fe3c4'; ctx.beginPath(); ctx.arc(psx+p.dir.x*8, psy+p.dir.y*8, 2.5, 0, 7); ctx.fill();
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
  const keyLabels = ['J', 'L'];
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
document.getElementById('sellJunk').onclick = () => {
  let g = 0;
  G.player.bag = G.player.bag.filter((it) => { if (it.rarity === 'common') { g += it.value; return false; } return true; });
  G.gold += g; log(`Sold commons for ${g} gold.`, 'var(--gold)'); renderInv();
};

const SLOT_ORDER = [['weapon','Weapon'],['weapon2','Off-hand'],['armor','Armor'],['trinket','Trinket']];
function renderInv() {
  const p = G.player;
  const eqList = document.getElementById('equipList'); eqList.innerHTML = '';
  for (const [slot, label] of SLOT_ORDER) {
    const it = p.equip[slot];
    const row = document.createElement('div'); row.className = 'equip-slot';
    row.innerHTML = `<span class="slotname">${label}</span><span class="iname" style="color:${it?it.rarityColor:'var(--dim)'}">${it?it.name:'— empty —'}</span>`;
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
  document.getElementById('bagCount') && (document.getElementById('bagCount').textContent = p.bag.length);
  // sort: rarity then ilvl
  const order = { legendary:5, epic:4, rare:3, uncommon:2, common:1 };
  [...p.bag].sort((a,b)=> (order[b.rarity]-order[a.rarity])||(b.ilvl-a.ilvl)).forEach((it) => {
    const c = document.createElement('div'); c.className='itemcard'; c.style.borderColor = it.rarityColor + '55';
    const affLines = it.affixes.map((a)=>`<div class="aff">${a.label}</div>`).join('');
    const abLine = it.ability ? `<div class="ab">✦ ${it.ability.name} — ${it.ability.desc}</div>` : '';
    const dmg = it.stats.dmgHi ? `<span class="tp">${it.stats.dmgLo}-${it.stats.dmgHi} dmg</span>` : it.stats.armor ? `<span class="tp">${it.stats.armor} armor</span>` : `<span class="tp">${it.rarityName}</span>`;
    c.innerHTML = `<div class="top"><span class="nm" style="color:${it.rarityColor}">${it.name}</span>${dmg}</div>${affLines}${abLine}`;
    c.onclick = () => { equipItem(it); renderInv(); };
    bag.appendChild(c);
  });
}

function equipItem(it) {
  const p = G.player;
  const slot = it.slot === 'weapon' ? (p.equip.weapon && !p.equip.weapon2 && it !== p.equip.weapon ? 'weapon' : 'weapon') : it.slot;
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
  const name = document.getElementById('nameInput').value.trim() || 'Wanderer';
  document.getElementById('menu').style.display = 'none';
  document.getElementById('log').innerHTML = '';
  newRun(seed, name);
  saveRun();
};
document.getElementById('resumeBtn').onclick = async () => {
  const ok = await loadRun();
  if (ok) document.getElementById('menu').style.display = 'none';
};

// ---------- boot ----------
resize();
loadScores();
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (G && G.alive) { update(dt); draw(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// autosave every 20s
setInterval(() => { if (G && G.alive) saveRun(); }, 20000);
