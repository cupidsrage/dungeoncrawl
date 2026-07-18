// gen.js — deterministic, seed-driven generation for dungeons, loot, and abilities.
// Pure functions only. Same seed + same inputs => same output, on client or server.

// ---------- RNG ----------
// Mulberry32: tiny, fast, good enough for a game. Deterministic from a 32-bit seed.
export function makeRNG(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min, // inclusive
    float: (min, max) => next() * (max - min) + min,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // weighted pick: items = [{w, ...}]
    weighted: (items) => {
      const total = items.reduce((s, i) => s + i.w, 0);
      let r = next() * total;
      for (const it of items) { if ((r -= it.w) < 0) return it; }
      return items[items.length - 1];
    },
    shuffle: (arr) => {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

// Hash a string to a 32-bit int (for turning a text seed into a number).
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

// Derive a sub-seed so each system (map/loot/monsters) rolls independently but reproducibly.
export function subSeed(seed, salt) {
  return hashSeed(`${seed}:${salt}`);
}

// ---------- DUNGEON ----------
export const MAP_W = 48;
export const MAP_H = 32;
export const T = { WALL: 0, FLOOR: 1, DOOR: 2, STAIRS: 3, ENTRY: 4 };

// BSP room-and-corridor generation.
export function generateDungeon(seed, floor) {
  const rng = makeRNG(subSeed(seed, `map:${floor}`));
  const grid = Array.from({ length: MAP_H }, () => new Array(MAP_W).fill(T.WALL));

  // Recursively split space into leaves; carve a room in each leaf.
  const leaves = [];
  const split = (x, y, w, h, depth) => {
    const minLeaf = 8;
    const canSplit = depth < 5 && (w > minLeaf * 2 || h > minLeaf * 2);
    if (!canSplit || (depth > 2 && rng.chance(0.25))) {
      leaves.push({ x, y, w, h });
      return;
    }
    const horizontal = w < h ? true : h < w ? false : rng.chance(0.5);
    if (horizontal) {
      const cut = rng.int(minLeaf, h - minLeaf);
      split(x, y, w, cut, depth + 1);
      split(x, y + cut, w, h - cut, depth + 1);
    } else {
      const cut = rng.int(minLeaf, w - minLeaf);
      split(x, y, cut, h, depth + 1);
      split(x + cut, y, w - cut, h, depth + 1);
    }
  };
  split(1, 1, MAP_W - 2, MAP_H - 2, 0);

  const rooms = [];
  for (const leaf of leaves) {
    const rw = rng.int(4, Math.max(4, leaf.w - 2));
    const rh = rng.int(4, Math.max(4, leaf.h - 2));
    const rx = leaf.x + rng.int(1, Math.max(1, leaf.w - rw - 1));
    const ry = leaf.y + rng.int(1, Math.max(1, leaf.h - rh - 1));
    const room = { x: rx, y: ry, w: rw, h: rh, cx: (rx + (rw >> 1)) | 0, cy: (ry + (rh >> 1)) | 0 };
    rooms.push(room);
    for (let yy = ry; yy < ry + rh; yy++)
      for (let xx = rx; xx < rx + rw; xx++)
        if (yy > 0 && yy < MAP_H && xx > 0 && xx < MAP_W) grid[yy][xx] = T.FLOOR;
  }

  // Connect rooms in order with L-shaped corridors (guarantees full connectivity).
  const carveH = (x1, x2, y) => { for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) if (grid[y][x] === T.WALL) grid[y][x] = T.FLOOR; };
  const carveV = (y1, y2, x) => { for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) if (grid[y][x] === T.WALL) grid[y][x] = T.FLOOR; };
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    if (rng.chance(0.5)) { carveH(a.cx, b.cx, a.cy); carveV(a.cy, b.cy, b.cx); }
    else { carveV(a.cy, b.cy, a.cx); carveH(a.cx, b.cx, b.cy); }
  }

  const entry = rooms[0];
  const exit = rooms[rooms.length - 1];
  grid[entry.cy][entry.cx] = T.ENTRY;
  grid[exit.cy][exit.cx] = T.STAIRS;

  return { grid, rooms, entry: { x: entry.cx, y: entry.cy }, exit: { x: exit.cx, y: exit.cy } };
}

// ---------- MONSTERS ----------
// behavior drives AI in the client:
//  chaser  - closes to melee range (now fast enough to threaten a kiting player)
//  charger - keeps loose distance, then lunges in a fast dash to strike
//  caster  - holds range and fires projectiles; retreats if you close in
//  bomber  - advances while lobbing slow arcing shots, dangerous at mid-range
const MONSTER_ARCHETYPES = [
  { key: 'grub', name: 'Cave Grub', glyph: 'g', hpMul: 0.8, dmgMul: 0.7, spd: 0.95, color: '#8fae6b', behavior: 'chaser' },
  { key: 'skitter', name: 'Skitterling', glyph: 's', hpMul: 0.55, dmgMul: 0.9, spd: 1.55, color: '#c9a24b', behavior: 'charger' },
  { key: 'brute', name: 'Stone Brute', glyph: 'B', hpMul: 2.0, dmgMul: 1.5, spd: 0.7, color: '#9a8f80', behavior: 'chaser', special: 'slam' },
  { key: 'shade', name: 'Hollow Shade', glyph: 'h', hpMul: 1.1, dmgMul: 1.0, spd: 1.15, color: '#7d6bad', behavior: 'caster', proj: 'void' },
  { key: 'spitter', name: 'Blight Spitter', glyph: 'y', hpMul: 1.15, dmgMul: 1.0, spd: 0.9, color: '#7bbf5a', behavior: 'bomber', proj: 'poison' },
  { key: 'warden', name: 'Rift Warden', glyph: 'W', hpMul: 1.6, dmgMul: 1.2, spd: 1.05, color: '#c0596b', behavior: 'caster', proj: 'fire', special: 'volley' },
];

export function generateMonsters(seed, floor, rooms) {
  const rng = makeRNG(subSeed(seed, `mob:${floor}`));
  const mobs = [];
  // Skip the entry room (index 0). Populate the rest.
  for (let i = 1; i < rooms.length; i++) {
    const room = rooms[i];
    const count = rng.int(0, Math.min(3, 1 + Math.floor(floor / 3)));
    for (let c = 0; c < count; c++) {
      // Wardens are rare; ranged types appear a bit more on deeper floors.
      const arch = rng.weighted(MONSTER_ARCHETYPES.map((a) => ({
        ...a,
        w: a.key === 'warden' ? 1
          : (a.behavior === 'caster' || a.behavior === 'bomber') ? 3 + Math.min(3, floor * 0.2)
          : 4,
      })));
      const level = floor + rng.int(-1, 1);
      const maxHp = Math.round((14 + level * 8) * arch.hpMul);
      const dmg = Math.round((3 + level * 2.2) * arch.dmgMul);
      const x = room.x + rng.int(0, room.w - 1);
      const y = room.y + rng.int(0, room.h - 1);
      mobs.push({
        id: `m${floor}_${i}_${c}`, key: arch.key, name: arch.name, glyph: arch.glyph,
        color: arch.color, x, y, hp: maxHp, maxHp, dmg, spd: arch.spd, level: Math.max(1, level),
        xp: Math.round(6 + level * 4 * arch.hpMul),
        behavior: arch.behavior, proj: arch.proj || null, special: arch.special || null,
      });
    }
  }
  // Guarantee a ranged presence: if a populated floor rolled all-melee, convert
  // one non-boss mob into a Hollow Shade so every floor has a shooting threat.
  if (mobs.length >= 2 && !mobs.some((m) => m.proj)) {
    const victim = mobs.find((m) => m.behavior === 'chaser') || mobs[mobs.length - 1];
    Object.assign(victim, {
      key: 'shade', name: 'Hollow Shade', glyph: 'h', color: '#7d6bad',
      behavior: 'caster', proj: 'void', special: null, spd: 1.15,
      hp: Math.round(victim.hp * 0.75), maxHp: Math.round(victim.maxHp * 0.75),
    });
  }
  // Boss on floors divisible by 5.
  if (floor % 5 === 0) {
    const room = rooms[rooms.length - 1];
    const level = floor + 2;
    mobs.push({
      id: `boss${floor}`, key: 'boss', name: bossName(rng), glyph: 'Ω', color: '#e0b341',
      x: room.cx, y: room.cy, hp: (40 + level * 22), maxHp: (40 + level * 22),
      dmg: Math.round(6 + level * 3), spd: 1.0, level, xp: 60 + level * 12, boss: true,
      behavior: 'boss', proj: rng.pick(['fire', 'void', 'poison']), special: 'volley',
    });
  }
  return mobs;
}

const BOSS_PRE = ['Grokk', 'Vael', 'Mourn', 'Xath', 'Ombra', 'Threx', 'Nyss'];
const BOSS_TITLE = ['the Devourer', 'the Unmade', 'Spire-Warden', 'the Hollow King', 'Gate-Keeper', 'the Rotcrown'];
function bossName(rng) { return `${rng.pick(BOSS_PRE)} ${rng.pick(BOSS_TITLE)}`; }

// ---------- LOOT ----------
export const RARITIES = [
  { key: 'common', name: 'Common', color: '#c8c8c8', w: 100, affixes: [0, 1], mul: 1.0 },
  { key: 'uncommon', name: 'Uncommon', color: '#5bcf6a', w: 55, affixes: [1, 2], mul: 1.15 },
  { key: 'rare', name: 'Rare', color: '#4aa3ff', w: 24, affixes: [2, 3], mul: 1.35 },
  { key: 'epic', name: 'Epic', color: '#b46bff', w: 9, affixes: [3, 4], mul: 1.6 },
  { key: 'legendary', name: 'Legendary', color: '#f0a733', w: 2.5, affixes: [4, 5], mul: 2.0 },
];

const BASES = {
  weapon: [
    { key: 'dagger', name: 'Dagger', dmg: [4, 7], spd: 1.5 },
    { key: 'sword', name: 'Sword', dmg: [7, 11], spd: 1.0 },
    { key: 'axe', name: 'Axe', dmg: [9, 15], spd: 0.8 },
    { key: 'staff', name: 'Staff', dmg: [5, 9], spd: 1.1 },
    { key: 'bow', name: 'Bow', dmg: [6, 10], spd: 1.2 },
  ],
  armor: [
    { key: 'robe', name: 'Robe', armor: [2, 5] },
    { key: 'leather', name: 'Leather Cuirass', armor: [4, 8] },
    { key: 'plate', name: 'Plate Harness', armor: [8, 14] },
  ],
  trinket: [
    { key: 'ring', name: 'Ring' },
    { key: 'amulet', name: 'Amulet' },
    { key: 'charm', name: 'Charm' },
  ],
};

// Affix pool. Each affix has a stat, a per-tier value range, and a name fragment.
const PREFIXES = [
  { stat: 'flatDmg', name: 'Jagged', range: [2, 6] },
  { stat: 'flatDmg', name: 'Cruel', range: [4, 9] },
  { stat: 'critChance', name: 'Keen', range: [0.03, 0.08] },
  { stat: 'armor', name: 'Ironbound', range: [3, 8] },
  { stat: 'maxHp', name: 'Vital', range: [8, 20] },
  { stat: 'fireDmg', name: 'Flaming', range: [3, 9] },
  { stat: 'coldDmg', name: 'Frostbitten', range: [3, 9] },
  { stat: 'lightningDmg', name: 'Storm', range: [2, 11] },
];
const SUFFIXES = [
  { stat: 'lifesteal', name: 'of Leeching', range: [0.03, 0.09] },
  { stat: 'critDmg', name: 'of Ruin', range: [0.15, 0.45] },
  { stat: 'moveSpeed', name: 'of Swiftness', range: [0.05, 0.15] },
  { stat: 'dodge', name: 'of Evasion', range: [0.03, 0.08] },
  { stat: 'regen', name: 'of Renewal', range: [0.5, 2.0] },
  { stat: 'maxHp', name: 'of the Bear', range: [10, 25] },
  { stat: 'cdr', name: 'of Alacrity', range: [0.05, 0.15] },
];

const STAT_LABEL = {
  flatDmg: '+{v} Damage', fireDmg: '+{v} Fire Damage', coldDmg: '+{v} Cold Damage',
  lightningDmg: '+{v} Lightning Damage', critChance: '+{p}% Crit Chance', critDmg: '+{p}% Crit Damage',
  armor: '+{v} Armor', maxHp: '+{v} Max HP', lifesteal: '{p}% Lifesteal', moveSpeed: '+{p}% Move Speed',
  dodge: '+{p}% Dodge', regen: '+{v} HP/sec Regen', cdr: '+{p}% Cooldown Reduction',
};

function fmtAffix(a) {
  const l = STAT_LABEL[a.stat] || `+{v} ${a.stat}`;
  const pct = /Chance|Damage %|Lifesteal|Speed|Dodge|Reduction|critDmg|critChance|cdr|lifesteal|moveSpeed|dodge/;
  const asPct = ['critChance', 'critDmg', 'lifesteal', 'moveSpeed', 'dodge', 'cdr'].includes(a.stat);
  return l.replace('{v}', a.value).replace('{p}', Math.round(a.value * 100));
}

// Roll an item. `magicFind` nudges rarity upward.
export function generateItem(seed, salt, floor, magicFind = 0) {
  const rng = makeRNG(subSeed(seed, `item:${salt}`));
  const slotRoll = rng.weighted([
    { w: 45, slot: 'weapon' }, { w: 35, slot: 'armor' }, { w: 20, slot: 'trinket' },
  ]);
  const slot = slotRoll.slot;
  const base = rng.pick(BASES[slot]);

  const rarity = rng.weighted(RARITIES.map((r) => ({ ...r, w: r.w * (1 + magicFind) * (r.key === 'common' ? 1 / (1 + magicFind * 0.5) : 1) })));
  const ilvl = floor + rng.int(0, 2);
  const scale = 1 + ilvl * 0.12;

  const item = { id: `${seed}_${salt}`, slot, base: base.key, rarity: rarity.key, ilvl, affixes: [], stats: {} };

  // Base stats.
  if (slot === 'weapon') {
    const lo = Math.round(base.dmg[0] * scale * rarity.mul);
    const hi = Math.round(base.dmg[1] * scale * rarity.mul);
    item.stats.dmgLo = lo; item.stats.dmgHi = hi; item.stats.spd = base.spd;
    // Every weapon carries a procedural ability.
    item.ability = generateAbility(seed, `${salt}:abil`, ilvl, rarity, base);
  } else if (slot === 'armor') {
    item.stats.armor = Math.round(rng.int(base.armor[0], base.armor[1]) * scale * rarity.mul);
  }

  // Roll affixes.
  const [aMin, aMax] = rarity.affixes;
  const nAffix = rng.int(aMin, aMax);
  const prefixPool = rng.shuffle(PREFIXES);
  const suffixPool = rng.shuffle(SUFFIXES);
  let pi = 0, si = 0;
  for (let i = 0; i < nAffix; i++) {
    const usePrefix = i % 2 === 0 ? pi < prefixPool.length : !(si < suffixPool.length);
    const src = usePrefix ? prefixPool[pi++] : suffixPool[si++];
    if (!src) continue;
    const isPctStat = ['critChance', 'critDmg', 'lifesteal', 'moveSpeed', 'dodge', 'cdr', 'regen'].includes(src.stat);
    let value = rng.float(src.range[0], src.range[1]) * (isPctStat ? 1 : scale) * rarity.mul;
    value = isPctStat ? Math.round(value * 100) / 100 : Math.round(value);
    const affix = { stat: src.stat, name: src.name, isPrefix: usePrefix, value };
    affix.label = fmtAffix(affix);
    item.affixes.push(affix);
    item.stats[src.stat] = (item.stats[src.stat] || 0) + value;
  }

  // Name.
  const prefix = item.affixes.find((a) => a.isPrefix);
  const suffix = item.affixes.find((a) => !a.isPrefix);
  item.name = [prefix?.name, base.name, suffix?.name].filter(Boolean).join(' ');
  item.rarityColor = rarity.color;
  item.rarityName = rarity.name;
  // Simple value for gold/sell.
  item.value = Math.round((ilvl * 5 + item.affixes.length * 8) * rarity.mul);
  return item;
}

// ---------- ABILITIES ----------
// Abilities are procedural: a delivery shape + damage type + scaling, rolled per-weapon.
const ABILITY_SHAPES = [
  { key: 'bolt', name: 'Bolt', desc: 'a fast projectile', w: 5, range: 8, cd: 0.9 },
  { key: 'nova', name: 'Nova', desc: 'a ring of force around you', w: 4, range: 3, cd: 2.2, aoe: true },
  { key: 'cleave', name: 'Cleave', desc: 'a wide arc in front', w: 4, range: 2, cd: 1.1, aoe: true },
  { key: 'lance', name: 'Lance', desc: 'a piercing line', w: 3, range: 6, cd: 1.4, pierce: true },
  { key: 'volley', name: 'Volley', desc: 'a spread of shots', w: 3, range: 7, cd: 1.8, multi: 3 },
  { key: 'chain', name: 'Chain', desc: 'a bolt that jumps between foes', w: 2, range: 6, cd: 1.6, chain: 3 },
];
const DMG_TYPES = [
  { key: 'phys', name: 'Physical', color: '#e8e2d0', onHit: null },
  { key: 'fire', name: 'Fire', color: '#ff7a3c', onHit: { status: 'burn', chance: 1.0, dur: 2.5 } },
  { key: 'cold', name: 'Cold', color: '#63c6ff', onHit: { status: 'chill', chance: 1.0, dur: 1.8, freezeAt: 3 } },
  { key: 'lightning', name: 'Lightning', color: '#ffe14a', onHit: { status: 'stun', chance: 0.22, dur: 0.7 } },
  { key: 'void', name: 'Void', color: '#b46bff', lifesteal: 0.1, onHit: { status: 'vulnerable', chance: 0.5, dur: 3 } },
  { key: 'poison', name: 'Poison', color: '#8fd14b', onHit: { status: 'poison', chance: 1.0, dur: 3 } },
];

// Status effect definitions — the single source of truth for both player and mobs.
// kind: 'debuff' | 'buff'. Fields consumed by the client's status engine.
export const STATUS = {
  burn:       { kind: 'debuff', name: 'Burn', color: '#ff7a3c', dot: 0.14, stacks: true, icon: '🔥' },
  poison:     { kind: 'debuff', name: 'Poison', color: '#8fd14b', dot: 0.11, stacks: true, icon: '☠' },
  slow:       { kind: 'debuff', name: 'Slow', color: '#7fb0d0', moveMul: 0.5, icon: '🐌' },
  chill:      { kind: 'debuff', name: 'Chill', color: '#63c6ff', moveMul: 0.6, buildsTo: 'freeze', icon: '❄' },
  freeze:     { kind: 'debuff', name: 'Freeze', color: '#a8e6ff', root: true, silence: true, icon: '🧊' },
  stun:       { kind: 'debuff', name: 'Stun', color: '#ffe14a', root: true, silence: true, icon: '💫' },
  weaken:     { kind: 'debuff', name: 'Weaken', color: '#c08a8a', dmgDealtMul: 0.6, icon: '▼' },
  vulnerable: { kind: 'debuff', name: 'Vulnerable', color: '#ff8ab0', dmgTakenMul: 1.35, icon: '◎' },
  // buffs (mostly player, from abilities/trinkets)
  haste:      { kind: 'buff', name: 'Haste', color: '#6fe3c4', moveMul: 1.5, icon: '»' },
  rage:       { kind: 'buff', name: 'Rage', color: '#ff5d6c', dmgDealtMul: 1.5, icon: '⚔' },
  fortify:    { kind: 'buff', name: 'Fortify', color: '#c9a24b', dmgTakenMul: 0.6, icon: '🛡' },
  regen:      { kind: 'buff', name: 'Regen', color: '#5bcf6a', heal: 4, icon: '✚' },
  shield:     { kind: 'buff', name: 'Shield', color: '#8fd1ff', absorb: true, icon: '◈' },
};
const ABILITY_ADJ = ['Searing', 'Riven', 'Umbral', 'Tempest', 'Gloom', 'Radiant', 'Wither', 'Fractal'];
const ABILITY_NOUN = { bolt: 'Bolt', nova: 'Burst', cleave: 'Sweep', lance: 'Lance', volley: 'Barrage', chain: 'Arc' };
// Some abilities grant a self-buff on cast (rarer, and better on higher rarities).
const SELF_BUFFS = ['haste', 'rage', 'fortify', 'shield', 'regen'];

export function generateAbility(seed, salt, ilvl, rarity, base) {
  const rng = makeRNG(subSeed(seed, `abil:${salt}`));
  const shape = rng.weighted(ABILITY_SHAPES);
  const dtype = rng.pick(DMG_TYPES);
  const scale = 1 + ilvl * 0.14;
  const power = Math.round(rng.int(6, 12) * scale * rarity.mul);
  const cd = Math.max(0.4, +(shape.cd * rng.float(0.85, 1.1) / rarity.mul).toFixed(2));
  const name = `${rng.pick(ABILITY_ADJ)} ${ABILITY_NOUN[shape.key]}`;

  // On-hit status from the damage type (guaranteed for elemental, chance for lightning/void).
  const onHit = dtype.onHit ? { ...dtype.onHit } : null;

  // Self-buff chance scales with rarity: common ~0, legendary ~55%.
  const rarityRank = ['common', 'uncommon', 'rare', 'epic', 'legendary'].indexOf(rarity.key);
  let selfBuff = null;
  if (rng.chance(0.1 + rarityRank * 0.11)) {
    const b = rng.pick(SELF_BUFFS);
    selfBuff = { status: b, dur: +(2 + rarityRank * 0.8).toFixed(1) };
  }

  const parts = [`Unleash ${shape.desc}`, `dealing ${power} ${dtype.name} damage`];
  if (shape.multi) parts.push(`(${shape.multi} projectiles)`);
  if (shape.chain) parts.push(`chaining to ${shape.chain} enemies`);
  if (shape.pierce) parts.push('piercing all in its path');
  if (onHit) {
    const s = STATUS[onHit.status];
    const chanceTxt = onHit.chance >= 1 ? 'inflicting' : `with a ${Math.round(onHit.chance * 100)}% chance to inflict`;
    parts.push(`${chanceTxt} ${s.name}`);
  }
  if (dtype.lifesteal) parts.push('healing you for part of the damage');
  if (selfBuff) parts.push(`and granting you ${STATUS[selfBuff.status].name} for ${selfBuff.dur}s`);

  return {
    name, shape: shape.key, shapeName: shape.name, range: shape.range,
    dmgType: dtype.key, dmgTypeName: dtype.name, color: dtype.color,
    power, cd, aoe: !!shape.aoe, pierce: !!shape.pierce, multi: shape.multi || 1,
    chain: shape.chain || 0, lifesteal: dtype.lifesteal || 0,
    onHit, selfBuff,
    desc: parts.join(' ') + '.',
  };
}

// Starting weapon so a new run isn't empty-handed. Rerolls the salt until a
// weapon (which always carries an ability) is produced, so the player can always attack.
export function starterWeapon(seed) {
  for (let i = 0; i < 40; i++) {
    const it = generateItem(seed, `starter${i}`, 1, 0);
    if (it.slot === 'weapon') return it;
  }
  // Fallback: hand-built basic weapon.
  return generateItem(seed, 'starter0', 1, 0);
}
