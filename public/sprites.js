// sprites.js — procedural pixel-art. Every creature, tile, and item is drawn ONCE
// onto a small offscreen canvas at load, then blitted each frame. Crisp, fast,
// and gives the game real character art instead of circles with letters.
//
// Art direction: a dark arcane spire. Cold stone, bioluminescent accents, each
// creature a readable silhouette tied to its behavior. Pixel grid = 16x16 per
// sprite (some 24x24 for the boss), scaled up with nearest-neighbor.

const cache = {};

// Build an offscreen canvas and hand its 2d context to a painter.
function make(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  paint(g, w, h);
  return c;
}

// Tiny pixel helper: fill a rect of the sprite grid in cell units.
function px(g, x, y, w, h, color) { g.fillStyle = color; g.fillRect(x, y, w, h); }

// ---------- palettes ----------
const P = {
  stone: '#232a3d', stoneLo: '#1a2030', stoneHi: '#2c3550', grout: '#121622',
  moss: '#2f4a3a', mossHi: '#3d6149',
  skin1: '#8fae6b', skinBrute: '#8a8073', skinShade: '#6a5a94', skinSpit: '#6fa64a',
  skinChar: '#caa24b', skinWard: '#b8505f',
  bone: '#d9d2be', eye: '#ffe14a', eyeRed: '#ff5d6c', eyeVoid: '#c98bff',
  hero: '#e7e3d4', heroShade: '#b9b39c', cloak: '#3a6f8f', cloakHi: '#4f97c0',
  steel: '#c8d0dc', steelLo: '#8791a3',
};

// ============ FLOOR & WALL TILES ============
// A few floor variants keyed by (x+y) so the ground reads as flagstones, not a checkerboard.
function floorTile(variant) {
  return make(20, 20, (g) => {
    const base = variant % 2 ? '#1b2130' : '#1e2436';
    px(g, 0, 0, 20, 20, base);
    // flagstone seams
    g.fillStyle = P.grout;
    g.fillRect(0, 0, 20, 1); g.fillRect(0, 0, 1, 20);
    // subtle speckle / wear, deterministic by variant
    const spots = [[4,5],[13,3],[8,12],[16,15],[3,16],[11,8]];
    for (let i = 0; i < spots.length; i++) {
      if ((variant + i) % 3 === 0) px(g, spots[i][0], spots[i][1], 2, 2, '#171c2a');
      else if ((variant + i) % 3 === 1) px(g, spots[i][0], spots[i][1], 1, 1, '#262d42');
    }
    // occasional moss on some variants
    if (variant % 4 === 2) { px(g, 2, 14, 4, 3, P.moss); px(g, 3, 13, 2, 1, P.mossHi); }
    if (variant % 4 === 3) { px(g, 14, 3, 3, 3, P.moss); px(g, 15, 3, 1, 1, P.mossHi); }
  });
}

// Wall block with a lit top edge and dark body, so walls read as raised stone.
function wallTile() {
  return make(20, 20, (g) => {
    px(g, 0, 0, 20, 20, '#0a0d15');
    px(g, 0, 0, 20, 20, '#0d1119');
    // brick courses
    g.fillStyle = '#141a27';
    g.fillRect(0, 3, 20, 6); g.fillRect(0, 12, 20, 6);
    g.fillStyle = '#0a0e16';
    g.fillRect(0, 9, 20, 1); g.fillRect(0, 18, 20, 1);
    g.fillRect(6, 3, 1, 6); g.fillRect(13, 12, 1, 6);
    // lit top lip
    px(g, 0, 0, 20, 2, '#28324a');
    px(g, 0, 2, 20, 1, '#1a2233');
  });
}

// Stairs-down: a dark descending shaft with glowing amber rim.
function stairsTile() {
  return make(20, 20, (g) => {
    px(g, 0, 0, 20, 20, '#141a28');
    // receding steps
    const steps = ['#1c2436','#171e2d','#121826','#0d121d','#080b12'];
    for (let i = 0; i < steps.length; i++) px(g, 2 + i, 3 + i * 3, 16 - i * 2, 3, steps[i]);
    // amber glow rim
    g.fillStyle = '#f0b341'; g.globalAlpha = .9;
    g.fillRect(2, 2, 16, 1); g.fillRect(2, 2, 1, 15); g.fillRect(17, 2, 1, 15);
    g.globalAlpha = 1;
  });
}

// Entry portal: cool teal arch.
function entryTile() {
  return make(20, 20, (g) => {
    px(g, 0, 0, 20, 20, '#141a28');
    g.strokeStyle = '#6fe3c4'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(10, 12, 6, Math.PI, 0); g.stroke();
    g.fillStyle = 'rgba(111,227,196,.15)'; g.fillRect(4, 12, 12, 7);
  });
}

// ============ CREATURES ============
// Each drawn on a 16x16 grid (boss 24x24), facing down/neutral. Two frames for a
// subtle idle bob are produced by shifting the body 1px.

// Cave Grub — low segmented worm, green.
function grub(g) {
  px(g, 4, 8, 8, 6, P.skin1);        // body
  px(g, 5, 7, 6, 1, '#a6c47f');      // hi-light back
  px(g, 4, 8, 8, 1, '#a6c47f');
  px(g, 3, 10, 1, 3, P.skin1); px(g, 12, 10, 1, 3, P.skin1); // stubs
  px(g, 6, 9, 4, 1, '#6d8a4f');      // segment lines
  px(g, 6, 11, 4, 1, '#6d8a4f');
  px(g, 5, 9, 1, 1, '#101408'); px(g, 10, 9, 1, 1, '#101408'); // eyes
}

// Skitterling (charger) — fast insectoid, amber, spindly legs.
function skitter(g) {
  px(g, 6, 6, 4, 5, P.skinChar);     // thorax
  px(g, 6, 5, 4, 1, '#e6c56a');
  px(g, 7, 4, 2, 2, '#e6c56a');      // head
  // legs
  g.fillStyle = '#7a5f28';
  g.fillRect(3, 7, 3, 1); g.fillRect(3, 9, 3, 1);
  g.fillRect(10, 7, 3, 1); g.fillRect(10, 9, 3, 1);
  g.fillRect(5, 11, 2, 3); g.fillRect(9, 11, 2, 3);
  px(g, 7, 4, 1, 1, '#1a1206'); px(g, 8, 4, 1, 1, '#1a1206'); // eyes
  px(g, 6, 6, 4, 1, '#ffe9a8');      // sheen
}

// Stone Brute (chaser+slam) — hulking golem, cracked rock.
function brute(g) {
  px(g, 3, 5, 10, 9, P.skinBrute);   // torso
  px(g, 3, 5, 10, 1, '#a39684');     // top light
  px(g, 2, 6, 1, 6, P.skinBrute); px(g, 13, 6, 1, 6, P.skinBrute); // shoulders
  px(g, 5, 3, 6, 3, '#7c7264');      // head
  px(g, 5, 3, 6, 1, '#948877');
  // glowing cracks
  g.fillStyle = '#ff8a4c';
  g.fillRect(6, 8, 1, 3); g.fillRect(9, 7, 1, 4); g.fillRect(7, 10, 3, 1);
  px(g, 6, 4, 1, 1, '#ffb060'); px(g, 9, 4, 1, 1, '#ffb060'); // eyes
  px(g, 2, 12, 3, 2, '#5f574b'); px(g, 11, 12, 3, 2, '#5f574b'); // feet
}

// Hollow Shade (caster) — wispy phantom, tattered, void eyes.
function shade(g) {
  // hood
  px(g, 5, 3, 6, 5, P.skinShade);
  px(g, 5, 3, 6, 1, '#7d6bad');
  px(g, 4, 5, 1, 3, P.skinShade); px(g, 11, 5, 1, 3, P.skinShade);
  // tattered robe fading to nothing
  g.fillStyle = '#574a78';
  g.fillRect(5, 8, 6, 3);
  g.globalAlpha = .7; g.fillRect(4, 11, 3, 2); g.fillRect(9, 11, 3, 2);
  g.globalAlpha = .4; g.fillRect(5, 13, 2, 1); g.fillRect(8, 13, 2, 1); g.fillRect(10, 12, 1, 2);
  g.globalAlpha = 1;
  // glowing void eyes
  px(g, 6, 5, 1, 2, P.eyeVoid); px(g, 9, 5, 1, 2, P.eyeVoid);
}

// Blight Spitter (bomber) — bloated toad, sickly green, sacs.
function spitter(g) {
  px(g, 3, 7, 10, 7, P.skinSpit);    // bulbous body
  px(g, 4, 6, 8, 1, '#8fce68');
  px(g, 3, 7, 10, 1, '#8fce68');
  // poison sacs
  px(g, 5, 9, 2, 2, '#b6e86a'); px(g, 9, 10, 2, 2, '#b6e86a');
  px(g, 5, 9, 1, 1, '#e8ffb0'); px(g, 9, 10, 1, 1, '#e8ffb0');
  // wide mouth
  px(g, 5, 12, 6, 1, '#2e4a1c');
  px(g, 4, 5, 2, 2, P.skinSpit); px(g, 10, 5, 2, 2, P.skinSpit); // eye bumps
  px(g, 4, 5, 1, 1, '#1a2810'); px(g, 11, 5, 1, 1, '#1a2810');   // eyes
}

// Rift Warden (caster+volley) — armored cultist, crimson, horned.
function warden(g) {
  px(g, 5, 5, 6, 8, P.skinWard);     // robed body
  px(g, 5, 5, 6, 1, '#d4606f');
  px(g, 4, 7, 1, 5, '#8f3d4a'); px(g, 11, 7, 1, 5, '#8f3d4a');
  // horned hood
  px(g, 5, 3, 6, 2, '#7a2f3a');
  px(g, 4, 2, 1, 2, P.bone); px(g, 11, 2, 1, 2, P.bone); // horns
  // fiery sigil
  g.fillStyle = '#ff7a3c';
  g.fillRect(7, 8, 2, 3); g.fillRect(6, 9, 4, 1);
  px(g, 6, 5, 1, 1, P.eye); px(g, 9, 5, 1, 1, P.eye); // eyes
}

// Boss — towering warden-king, 24x24, crown + robe + aura.
function boss(g) {
  px(g, 7, 8, 10, 13, '#3a2a3f');    // robe
  px(g, 7, 8, 10, 1, '#5a4560');
  px(g, 6, 10, 1, 9, '#2c1f30'); px(g, 17, 10, 1, 9, '#2c1f30');
  px(g, 8, 5, 8, 4, '#4a3550');      // head/hood
  // crown
  g.fillStyle = '#e0b341';
  g.fillRect(8, 3, 8, 2);
  g.fillRect(8, 1, 1, 2); g.fillRect(11, 1, 1, 2); g.fillRect(15, 1, 1, 2);
  // burning eyes
  px(g, 10, 6, 2, 2, '#ff5d6c'); px(g, 13, 6, 2, 2, '#ff5d6c');
  // chest sigil
  g.fillStyle = '#c98bff';
  g.fillRect(11, 12, 2, 4); g.fillRect(10, 13, 4, 1); g.fillRect(10, 15, 4, 1);
  // shoulder spikes
  px(g, 5, 9, 2, 2, '#e0b341'); px(g, 17, 9, 2, 2, '#e0b341');
}

// Hero — hooded adventurer with a cloak; facing marker drawn separately in-game.
function hero(g) {
  px(g, 6, 5, 4, 6, P.hero);         // body
  px(g, 6, 5, 4, 1, '#fff8e6');
  px(g, 6, 3, 4, 3, '#c9c3ac');      // hood/head
  px(g, 7, 4, 2, 1, '#f0ead4');
  // cloak
  g.fillStyle = P.cloak;
  g.fillRect(5, 6, 1, 6); g.fillRect(10, 6, 1, 6);
  g.fillRect(5, 11, 6, 2);
  px(g, 5, 6, 1, 1, P.cloakHi); px(g, 10, 6, 1, 1, P.cloakHi);
  // eyes glint
  px(g, 7, 4, 1, 1, '#2a2a2a'); px(g, 8, 4, 1, 1, '#2a2a2a');
}

// ============ PICKUPS ============
function goldCoin(g) {
  g.fillStyle = '#f0b341'; g.beginPath(); g.arc(5, 5, 4, 0, 7); g.fill();
  g.fillStyle = '#ffd97a'; g.beginPath(); g.arc(4, 4, 2, 0, 7); g.fill();
  g.fillStyle = '#a8761f'; g.fillRect(4, 4, 2, 2);
}
function hpOrb(g) {
  g.fillStyle = '#ff5d6c'; g.beginPath(); g.arc(5, 5, 4, 0, 7); g.fill();
  g.fillStyle = '#ffb0b8'; g.beginPath(); g.arc(4, 4, 1.6, 0, 7); g.fill();
}

// ============ BUILD & EXPORT ============
const CREATURE_PAINTERS = {
  grub, skitter, brute, shade, spitter, warden,
  boss: null, hero: null, // handled at larger sizes below
};

export function buildSprites() {
  // floors: 4 variants
  cache.floor = [0,1,2,3].map((v) => floorTile(v));
  cache.wall = wallTile();
  cache.stairs = stairsTile();
  cache.entry = entryTile();

  // creatures rendered at 16px grid, upscaled to 32px display sprite
  const SS = 16, DISP = 32;
  cache.mob = {};
  for (const [key, painter] of Object.entries(CREATURE_PAINTERS)) {
    if (!painter) continue;
    cache.mob[key] = make(DISP, DISP, (g) => {
      g.imageSmoothingEnabled = false;
      g.save(); g.scale(DISP / SS, DISP / SS);
      painter(g);
      g.restore();
    });
  }
  // boss at 24px grid -> 48px
  cache.mob.boss = make(48, 48, (g) => { g.imageSmoothingEnabled = false; g.save(); g.scale(2, 2); boss(g); g.restore(); });
  // hero
  cache.hero = make(DISP, DISP, (g) => { g.imageSmoothingEnabled = false; g.save(); g.scale(DISP / SS, DISP / SS); hero(g); g.restore(); });

  // pickups (10px grid -> 14px)
  cache.gold = make(14, 14, (g) => { g.save(); g.scale(1.4, 1.4); goldCoin(g); g.restore(); });
  cache.hp = make(14, 14, (g) => { g.save(); g.scale(1.4, 1.4); hpOrb(g); g.restore(); });

  return cache;
}

export function sprites() { return cache; }
