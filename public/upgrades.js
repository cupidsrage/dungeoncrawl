// upgrades.js — the account upgrade catalog. Shared by server (validates purchases,
// stores levels) and client (renders the hub, applies effects to a run). Single
// source of truth so costs and effects can never drift between the two.
//
// Each upgrade: id, name, description, an icon, the essence cost per level (as a
// function of the next level), maxLevel, and how it affects a run (`effect`).
// Costs are expressed as {tier: amount} maps — different upgrades draw on
// different essence tiers, so all five tiers stay meaningful.

// Cost helper: linear-ish growth per level, drawing from a given tier.
function cost(tier, base, growth) {
  return (nextLevel) => ({ [tier]: Math.round(base + growth * (nextLevel - 1)) });
}

export const UPGRADES = [
  // ---- STAT UPGRADES (common/uncommon essence — the bread and butter) ----
  {
    id: 'vitality', name: 'Vitality', icon: '❤',
    desc: '+15 max HP per level.',
    category: 'stats', maxLevel: 10,
    cost: cost('common', 8, 6),
    effect: (lvl) => ({ maxHp: 15 * lvl }),
  },
  {
    id: 'might', name: 'Might', icon: '⚔',
    desc: '+8% weapon & ability damage per level.',
    category: 'stats', maxLevel: 10,
    cost: cost('common', 10, 8),
    effect: (lvl) => ({ dmgMul: 1 + 0.08 * lvl }),
  },
  {
    id: 'precision', name: 'Precision', icon: '✦',
    desc: '+3% crit chance per level.',
    category: 'stats', maxLevel: 8,
    cost: cost('uncommon', 6, 4),
    effect: (lvl) => ({ critChance: 0.03 * lvl }),
  },
  {
    id: 'alacrity', name: 'Alacrity', icon: '»',
    desc: '+4% cooldown reduction per level.',
    category: 'stats', maxLevel: 8,
    cost: cost('uncommon', 8, 5),
    effect: (lvl) => ({ cdr: 0.04 * lvl }),
  },
  {
    id: 'ward', name: 'Ward', icon: '🛡',
    desc: '+6 armor per level.',
    category: 'stats', maxLevel: 8,
    cost: cost('uncommon', 6, 4),
    effect: (lvl) => ({ armor: 6 * lvl }),
  },
  {
    id: 'swiftness', name: 'Swiftness', icon: '➤',
    desc: '+3% move speed per level.',
    category: 'stats', maxLevel: 6,
    cost: cost('rare', 4, 3),
    effect: (lvl) => ({ moveSpeed: 0.03 * lvl }),
  },

  // ---- UTILITY / ECONOMY (rare essence) ----
  {
    id: 'attunement', name: 'Essence Attunement', icon: '◈',
    desc: '+10% essence from destroyed items per level.',
    category: 'utility', maxLevel: 5,
    cost: cost('rare', 6, 5),
    effect: (lvl) => ({ essenceMul: 1 + 0.10 * lvl }),
  },
  {
    id: 'fortune', name: 'Fortune', icon: '♦',
    desc: '+8% magic find (better drops) per level.',
    category: 'utility', maxLevel: 5,
    cost: cost('rare', 8, 6),
    effect: (lvl) => ({ magicFind: 0.08 * lvl }),
  },
  {
    id: 'prosperity', name: 'Prosperity', icon: '⬤',
    desc: 'Start each run with +50 gold per level.',
    category: 'utility', maxLevel: 4,
    cost: cost('common', 12, 8),
    effect: (lvl) => ({ startGold: 50 * lvl }),
  },

  // ---- UNLOCKS (epic essence — one-time, level 1 only) ----
  {
    id: 'dualwield', name: 'Dual Wield Training', icon: '⚔⚔',
    desc: 'Start every run with the off-hand weapon slot ready to use.',
    category: 'unlocks', maxLevel: 1,
    cost: () => ({ epic: 10 }),
    effect: () => ({ offhandUnlocked: true }),
  },
  {
    id: 'armory', name: "Armorer's Cache", icon: '⬗',
    desc: 'Start each run with a guaranteed Rare-tier weapon instead of a Common one.',
    category: 'unlocks', maxLevel: 1,
    cost: () => ({ epic: 8 }),
    effect: () => ({ starterTier: 'rare' }),
  },
  {
    id: 'greed', name: 'Greed', icon: '★',
    desc: 'Salvaging Common/Uncommon junk yields +1 essence each.',
    category: 'unlocks', maxLevel: 1,
    cost: () => ({ epic: 6 }),
    effect: () => ({ salvageBonus: 1 }),
  },

  // ---- HEROES (epic/legendary essence — one-time playable character unlocks) ----
  {
    id: 'char_ember', name: 'Ember Arcanist', icon: '🔥',
    desc: 'Unlock a caster who deals +25% fire damage, has +8% cooldown reduction, but -10 max HP.',
    category: 'characters', maxLevel: 1, characterId: 'ember',
    cost: () => ({ epic: 12 }),
    effect: () => ({ unlockedCharacters: ['ember'] }),
  },
  {
    id: 'char_iron', name: 'Iron Vanguard', icon: '🛡',
    desc: 'Unlock a stalwart delver with +35 max HP and +12 armor, but -6% move speed.',
    category: 'characters', maxLevel: 1, characterId: 'iron',
    cost: () => ({ epic: 14 }),
    effect: () => ({ unlockedCharacters: ['iron'] }),
  },
  {
    id: 'char_shade', name: 'Moonlit Shade', icon: '☾',
    desc: 'Unlock a swift assassin with +12% crit chance and +10% move speed, but -15 max HP.',
    category: 'characters', maxLevel: 1, characterId: 'shade',
    cost: () => ({ legendary: 4 }),
    effect: () => ({ unlockedCharacters: ['shade'] }),
  },

  // ---- DEEP START (legendary essence — the big-ticket progression) ----
  // Each tier lets you optionally begin a run on that floor. Purchases are
  // cumulative — buying "floor 10" implies you can also pick floor 5 or floor 1.
  {
    id: 'descent5', name: 'Descent I', icon: '▼',
    desc: 'Unlock the option to start runs at Floor 5.',
    category: 'descent', maxLevel: 1, deepStartFloor: 5,
    cost: () => ({ legendary: 3 }),
    effect: () => ({ deepStart: 5 }),
  },
  {
    id: 'descent10', name: 'Descent II', icon: '▼▼',
    desc: 'Unlock the option to start runs at Floor 10.',
    category: 'descent', maxLevel: 1, deepStartFloor: 10, requires: 'descent5',
    cost: () => ({ legendary: 6 }),
    effect: () => ({ deepStart: 10 }),
  },
  {
    id: 'descent15', name: 'Descent III', icon: '▼▼▼',
    desc: 'Unlock the option to start runs at Floor 15.',
    category: 'descent', maxLevel: 1, deepStartFloor: 15, requires: 'descent10',
    cost: () => ({ legendary: 10 }),
    effect: () => ({ deepStart: 15 }),
  },
];

export const UPGRADE_CATEGORIES = [
  { key: 'stats', name: 'Attributes' },
  { key: 'utility', name: 'Fortune' },
  { key: 'unlocks', name: 'Unlocks' },
  { key: 'characters', name: 'Characters' },
  { key: 'descent', name: 'Deep Descent' },
];

// Given an account's upgrade levels {id: level}, compute the merged effect bag
// applied to a run. Later effects overwrite scalars; multipliers are combined.
export function computeUpgradeEffects(levels) {
  const eff = {
    maxHp: 0, dmgMul: 1, critChance: 0, cdr: 0, armor: 0, moveSpeed: 0,
    essenceMul: 1, magicFind: 0, startGold: 0,
    offhandUnlocked: false, starterTier: null, salvageBonus: 0,
    deepStarts: [],   // sorted list of unlocked deep-start floors
    unlockedCharacters: ['wanderer'],
  };
  for (const up of UPGRADES) {
    const lvl = levels?.[up.id] || 0;
    if (lvl <= 0) continue;
    const e = up.effect(lvl);
    for (const [k, v] of Object.entries(e)) {
      if (k === 'deepStart') { eff.deepStarts.push(v); }
      else if (k === 'unlockedCharacters') { eff.unlockedCharacters.push(...v); }
      else if (typeof v === 'boolean') { eff[k] = eff[k] || v; }
      else if (['dmgMul', 'essenceMul'].includes(k)) { eff[k] *= v; }
      else if (k === 'starterTier') { eff.starterTier = v; }
      else { eff[k] = (typeof eff[k] === 'number' ? eff[k] : 0) + v; }
    }
  }
  eff.deepStarts.sort((a, b) => a - b);
  eff.unlockedCharacters = [...new Set(eff.unlockedCharacters)];
  return eff;
}

// Cost to buy the NEXT level of an upgrade for an account at the given levels.
// Returns null if already maxed or a prerequisite isn't met.
export function nextCost(up, levels) {
  const cur = levels?.[up.id] || 0;
  if (cur >= up.maxLevel) return null;
  if (up.requires && !(levels?.[up.requires] > 0)) return null;
  return up.cost(cur + 1);
}


export const CHARACTERS = [
  {
    id: 'wanderer', name: 'Wanderer', icon: '◆', color: '#6fe3c4',
    desc: 'Balanced adventurer with no strengths or weaknesses.',
    effects: {},
  },
  {
    id: 'ember', name: 'Ember Arcanist', icon: '🔥', color: '#ff8a5c',
    desc: '+25% fire damage and +8% cooldown reduction, but -10 max HP.',
    effects: { fireDmgMul: 1.25, cdr: 0.08, maxHp: -10 },
  },
  {
    id: 'iron', name: 'Iron Vanguard', icon: '🛡', color: '#8fd1ff',
    desc: '+35 max HP and +12 armor, but -6% move speed.',
    effects: { maxHp: 35, armor: 12, moveSpeed: -0.06 },
  },
  {
    id: 'shade', name: 'Moonlit Shade', icon: '☾', color: '#c86bff',
    desc: '+12% crit chance and +10% move speed, but -15 max HP.',
    effects: { critChance: 0.12, moveSpeed: 0.10, maxHp: -15 },
  },
];

export function availableCharacters(levels) {
  const eff = computeUpgradeEffects(levels || {});
  return CHARACTERS.filter((c) => eff.unlockedCharacters.includes(c.id));
}

export function characterById(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}
