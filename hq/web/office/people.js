// Procedural pixel people for the RedPi Office: portraits (18×28) and walking
// scene sprites (18×32, front/back, 3 walk phases).
//
// Ported from munder-difflin (scene/office/portraitArt.ts),
// Copyright (c) 2026 Chaitanya Giri, MIT License. The drawing primitives, head,
// face, hairstyles, facial hair, glasses, clothing and outline pass follow the
// original. Changes for RedPi: plain JS, and the fixed TV-cast recipes are
// replaced by recipeFor(), which derives a deterministic look from a worker's
// name and role (no likeness of any real or fictional person).

export const PORTRAIT_W = 18, PORTRAIT_H = 28, SCENE_W = 18, SCENE_H = 32;
const OUTLINE = [18, 28, 22];
const HX0 = 4, HX1 = 13;
let CUR_W = PORTRAIT_W, CUR_H = PORTRAIT_H;

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function shades(rgb, dl = 1.22, dd = 0.68) {
  return [rgb.map((c) => clamp(c * dl)), rgb.slice(), rgb.map((c) => clamp(c * dd))];
}
function set(buf, x, y, c, a = 255) {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return;
  const i = (y * CUR_W + x) * 4;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a;
}
function alphaAt(buf, x, y) {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return 0;
  return buf[(y * CUR_W + x) * 4 + 3];
}
function rgbAt(buf, x, y) { const i = (y * CUR_W + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; }
const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function rect(buf, x0, y0, x1, y1, c) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(buf, x, y, c); }

const SKIN = {
  light: { hi: [255, 221, 189], base: [247, 201, 170], sh: [212, 158, 126], line: [168, 112, 82] },
  tan: { hi: [232, 182, 136], base: [214, 162, 116], sh: [176, 126, 86], line: [138, 92, 60] },
  brown: { hi: [180, 130, 94], base: [158, 112, 78], sh: [124, 86, 58], line: [90, 60, 40] },
  dark: { hi: [142, 98, 70], base: [120, 80, 56], sh: [94, 62, 42], line: [64, 42, 28] },
};

function drawHead(buf, skin) {
  const s = SKIN[skin];
  for (let y = 4; y <= 16; y++) for (let x = HX0; x <= HX1; x++) {
    if (((x === HX0 || x === HX1) && (y === 4 || y === 5 || y === 16)) || ((x === 5 || x === 12) && y === 4)) continue;
    set(buf, x, y, s.base);
  }
  for (let y = 6; y < 12; y++) set(buf, 5, y, s.hi);
  set(buf, 6, 5, s.hi); set(buf, 7, 5, s.hi);
  for (let y = 6; y < 15; y++) set(buf, 12, y, s.sh);
  for (const x of [7, 8, 9, 10, 11]) set(buf, x, 16, s.sh);
  for (const ex of [HX0 - 1, HX1 + 1]) { set(buf, ex, 9, s.base); set(buf, ex, 10, s.base); set(buf, ex, 11, s.sh); }
  rect(buf, 7, 17, 10, 18, s.sh); rect(buf, 7, 17, 9, 17, s.base);
}

function drawFace(buf, skin, brow, mouth, blush, lashes) {
  const s = SKIN[skin];
  const white = [250, 248, 244], pup = [46, 38, 42];
  for (const [a, b, p] of [[5, 6, 6], [10, 11, 10]]) { set(buf, a, 9, white); set(buf, b, 9, white); set(buf, p, 9, pup); }
  if (lashes) {
    const lash = [54, 40, 48], glint = [252, 250, 248];
    for (const x of [5, 6, 10, 11]) set(buf, x, 8, lash);
    set(buf, 4, 8, lash); set(buf, 12, 8, lash);
    set(buf, 5, 9, glint); set(buf, 10, 9, glint);
  }
  if (brow === "flat") for (const x of [5, 6, 10, 11]) set(buf, x, 7, s.line);
  else if (brow === "angry") { set(buf, 5, 8, s.line); set(buf, 6, 7, s.line); set(buf, 10, 7, s.line); set(buf, 11, 8, s.line); }
  else if (brow === "raised") for (const x of [5, 6, 10, 11]) set(buf, x, 6, s.line);
  else if (brow === "soft") { for (const x of [5, 11]) set(buf, x, 7, s.line); for (const x of [6, 10]) set(buf, x, 7, s.sh); }
  set(buf, 8, 11, s.sh); set(buf, 8, 12, s.sh); set(buf, 7, 12, s.sh);
  const mc = [158, 86, 80];
  const mouths = {
    neutral: [[7, 14], [8, 14], [9, 14], [10, 14]],
    smile: [[7, 14], [8, 14], [9, 14], [10, 14], [6, 13], [11, 13]],
    frown: [[7, 15], [8, 15], [9, 15], [10, 15], [6, 14], [11, 14]],
    grin: [[7, 14], [8, 14], [9, 14], [10, 14], [7, 13], [8, 13], [9, 13], [10, 13], [6, 13], [11, 13]],
  };
  for (const [x, y] of mouths[mouth]) set(buf, x, y, mc);
  if (blush) for (const x of [5, 12]) set(buf, x, 12, [235, 150, 140], 140);
}

const HAIR = {
  styleShort(buf, color, skinBase, a) {
    const [hi, base, sh] = shades(color);
    const part = a.part ?? "L", recede = a.recede ?? 0;
    rect(buf, HX0, 2, HX1, 4, base);
    for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
    rect(buf, HX0 - 1, 4, HX1 + 1, 5, base);
    for (let y = 6; y < 9; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
    for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
    if (recede) { for (let y = 3; y < 6; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(buf, x, y), base)) set(buf, x, y, skinBase); set(buf, 8, 5, base); }
    const hx = part === "L" ? 6 : 11;
    for (let y = 2; y < 6; y++) set(buf, hx, y, sh);
    for (let x = HX0; x < hx; x++) if (alphaAt(buf, x, 3)) set(buf, x, 3, hi);
    for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
  },
  styleFloppy(buf, color) {
    const [hi, base] = shades(color);
    rect(buf, HX0, 2, HX1, 4, base);
    for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
    rect(buf, HX0 - 1, 4, HX1 + 1, 5, base);
    for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
    for (let x = 6; x <= 12; x++) set(buf, x, 6, base);
    set(buf, 9, 7, base); set(buf, 10, 7, base); set(buf, 11, 7, base);
    for (let y = 6; y < 9; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
    for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
    for (const x of [7, 8, 9]) set(buf, x, 6, hi);
  },
  styleFrame(buf, color, skinBase, a) {
    const [hi, base, sh] = shades(color);
    const length = a.length ?? 17, vol = a.vol ?? 1;
    rect(buf, HX0 - 1, 2, HX1 + 1, 5, base);
    for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
    for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
    for (let x = 6; x < 12; x++) set(buf, x, 6, base);
    set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
    for (let y = 6; y <= length; y++) {
      for (let dx = 0; dx < vol; dx++) { set(buf, HX0 - 1 - dx, y, base); set(buf, HX1 + 1 + dx, y, base); }
      set(buf, HX0, y, base); set(buf, HX1, y, base);
    }
    for (let x = HX0 - 1; x < HX0 + 1; x++) set(buf, x, length + 1, base);
    for (let x = HX1; x < HX1 + 2; x++) set(buf, x, length + 1, base);
    for (let y = 2; y < 6; y++) if (alphaAt(buf, HX1, y)) set(buf, HX1, y, sh);
    for (let x = HX0; x < 9; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
  },
  styleBun(buf, color, skinBase) {
    const [hi, base] = shades(color);
    rect(buf, HX0, 3, HX1, 5, base);
    for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
    for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
    for (let x = 6; x < 12; x++) set(buf, x, 6, base);
    set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
    for (let y = 6; y < 9; y++) { set(buf, HX0, y, base); set(buf, HX1, y, base); }
    rect(buf, 7, 1, 10, 2, base);
    for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 3)) set(buf, x, 3, hi);
  },
  styleCurly(buf, color, skinBase) {
    const [hi, base] = shades(color);
    const pts = [[4, 3], [5, 2], [6, 3], [7, 2], [8, 3], [9, 2], [10, 3], [11, 2], [12, 3], [13, 3], [3, 4], [4, 4], [13, 4], [14, 4], [3, 5], [4, 5], [13, 5], [14, 5], [3, 6], [13, 6], [4, 6], [12, 6], [3, 7], [13, 7], [4, 7]];
    rect(buf, HX0, 3, HX1, 5, base);
    for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
    for (const [x, y] of pts) set(buf, x, y, base);
    for (let x = 6; x < 12; x++) set(buf, x, 6, base);
    set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
    for (const [x, y] of [[5, 2], [7, 2], [9, 2], [11, 2]]) set(buf, x, y, hi);
  },
  styleMessy(buf, color, skinBase, a) {
    const [hi, base] = shades(color);
    const length = a.length ?? 8;
    rect(buf, HX0 - 1, 2, HX1 + 1, 5, base);
    const spikes = [[3, 2], [5, 1], [7, 2], [9, 1], [11, 2], [13, 1], [14, 2], [4, 2], [12, 2]];
    for (const [x, y] of spikes) set(buf, x, y, base);
    for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
    for (let x = 6; x < 12; x++) set(buf, x, 6, base);
    set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
    for (let y = 6; y <= length; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
    for (const [x, y] of spikes) set(buf, x, y, hi);
  },
  styleRecede(buf, color, skinBase) {
    const [, base, sh] = shades(color);
    for (let y = 4; y < 10; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
    for (let x = HX0; x <= HX1; x++) set(buf, x, 4, base);
    for (let x = HX0 + 1; x < HX1; x++) set(buf, x, 5, base);
    for (let y = 5; y < 9; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(buf, x, y), base)) set(buf, x, y, skinBase);
    for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 4)) set(buf, x, 4, sh);
  },
  styleSpiky(buf, color, skinBase) {
    const [hi, base] = shades(color);
    rect(buf, HX0, 3, HX1, 5, base);
    for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
    for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
    const spikes = [[5, 2], [7, 1], [9, 2], [11, 1], [6, 2], [8, 2], [10, 2], [12, 2]];
    for (const [x, y] of spikes) set(buf, x, y, base);
    for (let x = 6; x < 12; x++) set(buf, x, 6, base);
    set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
    for (let y = 6; y < 8; y++) { set(buf, HX0, y, base); set(buf, HX1, y, base); }
    for (const [x, y] of spikes) set(buf, x, y, hi);
  },
  styleBald(buf, color, skinBase, a) {
    const [shi, sbase, ssh] = shades(skinBase, 1.1, 0.82);
    for (let x = 6; x <= 11; x++) set(buf, x, 2, sbase);
    for (let x = 5; x <= 12; x++) set(buf, x, 3, sbase);
    for (let x = HX0; x <= HX1; x++) set(buf, x, 4, sbase);
    for (const x of [7, 8, 9]) set(buf, x, 2, shi);
    set(buf, 6, 3, shi); set(buf, 7, 3, shi);
    set(buf, 5, 3, ssh); set(buf, 12, 3, ssh); set(buf, HX1, 4, ssh);
    const [, base, sh] = shades(color);
    const top = a.recede ? 8 : 6;
    for (let y = top; y <= 10; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
    for (let y = top; y <= 10; y++) { set(buf, HX0 - 1, y, sh); set(buf, HX1 + 1, y, sh); }
  },
};

function drawFacial(buf, kind, color) {
  const [, base, sh] = shades(color);
  if (kind === "mustache") { for (const x of [6, 7, 8, 9, 10]) set(buf, x, 13, base); set(buf, 6, 12, base); set(buf, 10, 12, base); }
  else if (kind === "mustacheSm") for (const x of [7, 8, 9]) set(buf, x, 13, base);
  else if (kind === "stubble") for (const [x, y] of [[5, 14], [6, 15], [7, 15], [8, 15], [9, 15], [10, 15], [11, 14], [12, 13], [4, 13], [5, 15], [10, 15]]) set(buf, x, y, sh, 150);
  else if (kind === "goatee") { for (const x of [8, 9]) set(buf, x, 15, base); set(buf, 8, 14, base); set(buf, 9, 14, base); for (const x of [7, 8, 9, 10]) set(buf, x, 13, base); }
}

function drawGlasses(buf) {
  const frame = [60, 54, 62], glint = [236, 240, 246];
  for (const x of [5, 6]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
  set(buf, 4, 9, frame); set(buf, 7, 9, frame); set(buf, 4, 8, frame); set(buf, 7, 8, frame);
  for (const x of [10, 11]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
  set(buf, 9, 9, frame); set(buf, 12, 9, frame); set(buf, 9, 8, frame); set(buf, 12, 8, frame);
  set(buf, 8, 8, frame); set(buf, 3, 9, frame); set(buf, 13, 9, frame);
  set(buf, 4, 8, glint); set(buf, 9, 8, glint);
}

function bodyShape(buf, col, heavy) {
  const [, base, sh] = shades(col);
  const rows = heavy
    ? [[19, 5, 12], [20, 3, 14], [21, 2, 15], [22, 1, 16], [23, 1, 16], [24, 0, 17], [25, 0, 17], [26, 0, 17], [27, 0, 17]]
    : [[19, 6, 11], [20, 4, 13], [21, 3, 14], [22, 2, 15], [23, 2, 15], [24, 1, 16], [25, 1, 16], [26, 1, 16], [27, 1, 16]];
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, base);
  const [lo, hi] = heavy ? [1, 16] : [2, 15];
  for (let y = 22; y < 28; y++) { set(buf, lo, y, sh); set(buf, hi, y, sh); }
}

function drawClothing(buf, r) {
  const [hi, base, sh] = shades(r.c1);
  bodyShape(buf, r.c1, r.heavy);
  if (r.cloth === "suit") {
    const white = [238, 238, 236];
    for (const [x, y] of [[8, 19], [9, 19], [7, 20], [8, 20], [9, 20], [10, 20], [8, 21], [9, 21]]) set(buf, x, y, white);
    for (const [x, y] of [[6, 20], [7, 21], [11, 20], [10, 21], [6, 21], [11, 21]]) set(buf, x, y, sh);
    if (r.tie) { for (let y = 20; y < 26; y++) { set(buf, 8, y, r.tie); set(buf, 9, y, r.tie); } set(buf, 8, 20, shades(r.tie)[0]); }
    else for (let y = 22; y < 26; y++) { set(buf, 8, y, white); set(buf, 9, y, white); }
  } else if (r.cloth === "dressshirt") {
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19], [7, 20], [10, 20]]) set(buf, x, y, sh);
    for (let y = 20; y < 27; y += 2) set(buf, 8, y, sh);
    if (r.tie) for (let y = 19; y < 26; y++) { set(buf, 8, y, r.tie); set(buf, 9, y, r.tie); }
  } else if (r.cloth === "polo") {
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19]]) set(buf, x, y, hi);
    set(buf, 8, 20, sh); set(buf, 8, 22, sh);
    const accent = r.c2 ? shades(r.c2)[1] : hi;
    for (const [x, y] of [[7, 20], [9, 20]]) set(buf, x, y, accent);
  } else if (r.cloth === "blouse") {
    const s = SKIN[r.skin];
    for (const [x, y] of [[7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]]) set(buf, x, y, s.sh);
    for (let x = 5; x < 13; x++) if (eq(rgbAt(buf, x, 20), base)) set(buf, x, 20, hi);
  } else if (r.cloth === "cardigan") {
    const inner = r.c2 ? shades(r.c2)[1] : [235, 233, 226];
    for (let y = 19; y < 27; y++) { set(buf, 8, y, inner); set(buf, 9, y, inner); }
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19]]) set(buf, x, y, sh);
  } else if (r.cloth === "sweater") {
    for (const [x, y] of [[6, 19], [7, 19], [8, 19], [9, 19], [10, 19], [11, 19]]) set(buf, x, y, sh);
  }
}

const SHOE = [44, 40, 48];
function drawSceneLegs(buf, pants, phase) {
  const [, base, sh] = shades(pants);
  for (const [lx0, lx1] of [[5, 7], [10, 12]]) { rect(buf, lx0, 25, lx1, 30, base); for (let y = 25; y <= 30; y++) set(buf, lx1, y, sh); }
  const leftLow = phase !== 1, rightLow = phase !== 2;
  rect(buf, 5, leftLow ? 31 : 30, 7, leftLow ? 31 : 30, SHOE);
  rect(buf, 10, rightLow ? 31 : 30, 12, rightLow ? 31 : 30, SHOE);
}

function drawSceneTorso(buf, r, back) {
  const [hi, base, sh] = shades(r.c1);
  if (r.heavy) {
    rect(buf, 3, 18, 14, 18, base); rect(buf, 2, 19, 15, 19, base); rect(buf, 2, 20, 15, 24, base);
    for (let y = 20; y <= 24; y++) { set(buf, 2, y, sh); set(buf, 15, y, sh); set(buf, 14, y, sh); }
  } else {
    rect(buf, 4, 18, 13, 18, base); rect(buf, 3, 19, 14, 19, base); rect(buf, 4, 20, 13, 24, base);
    for (let y = 20; y <= 24; y++) { set(buf, 3, y, sh); set(buf, 14, y, sh); set(buf, 13, y, sh); }
  }
  if (back) { rect(buf, 6, 18, 11, 18, sh); for (let y = 19; y <= 24; y++) set(buf, 8, y, sh); return; }
  const skin = SKIN[r.skin];
  if (r.cloth === "suit") {
    const white = [238, 238, 236];
    for (const [x, y] of [[8, 18], [9, 18], [7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]]) set(buf, x, y, white);
    for (const [x, y] of [[6, 19], [7, 20], [11, 19], [10, 20]]) set(buf, x, y, sh);
    if (r.tie) { for (let y = 19; y <= 24; y++) { set(buf, 8, y, r.tie); set(buf, 9, y, r.tie); } set(buf, 8, 19, shades(r.tie)[0]); }
  } else if (r.cloth === "dressshirt") {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18], [7, 19], [10, 19]]) set(buf, x, y, sh);
    if (r.tie) for (let y = 18; y <= 24; y++) { set(buf, 8, y, r.tie); set(buf, 9, y, r.tie); }
    else for (let y = 20; y <= 24; y += 2) set(buf, 8, y, sh);
  } else if (r.cloth === "polo") {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]]) set(buf, x, y, hi);
    set(buf, 8, 19, sh); set(buf, 8, 21, sh);
  } else if (r.cloth === "blouse") {
    for (const [x, y] of [[7, 18], [8, 18], [9, 18], [10, 18], [8, 19], [9, 19]]) set(buf, x, y, skin.sh);
    for (let x = 5; x < 13; x++) if (eq(rgbAt(buf, x, 19), base)) set(buf, x, 19, hi);
  } else if (r.cloth === "cardigan") {
    const inner = r.c2 ? shades(r.c2)[1] : [235, 233, 226];
    for (let y = 18; y <= 24; y++) { set(buf, 8, y, inner); set(buf, 9, y, inner); }
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]]) set(buf, x, y, sh);
  } else if (r.cloth === "sweater") {
    for (const [x, y] of [[6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18]]) set(buf, x, y, sh);
  }
}

function drawHeadBack(buf, r) {
  const s = SKIN[r.skin];
  const rows = [[2, 6, 11], [3, 5, 12], [4, 4, 13], [5, 4, 13], [6, 4, 13], [7, 4, 13], [8, 4, 13], [9, 4, 13], [10, 4, 13], [11, 4, 13], [12, 4, 13], [13, 5, 12], [14, 6, 11]];
  if (r.hair === "styleBald") {
    const [shi, sbase, ssh] = shades(s.base, 1.1, 0.82);
    for (const [y, a, b] of rows) rect(buf, a, y, b, y, sbase);
    for (let y = 4; y <= 12; y++) { set(buf, 4, y, ssh); set(buf, 13, y, ssh); }
    for (const [x, y] of [[7, 2], [8, 2], [9, 2], [8, 3], [9, 4], [9, 5]]) set(buf, x, y, shi);
    const [, base, sh] = shades(r.hairc);
    for (let x = 4; x <= 13; x++) { set(buf, x, 11, base); set(buf, x, 12, base); }
    for (const x of [4, 13]) { set(buf, x, 11, sh); set(buf, x, 12, sh); }
    rect(buf, 7, 14, 10, 14, s.sh); rect(buf, 7, 15, 10, 17, s.sh); rect(buf, 7, 15, 9, 15, s.base);
    return;
  }
  const [hi, base, sh] = shades(r.hairc);
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, base);
  const len = r.hair === "styleFrame" ? (r.hairargs?.length ?? 17) : r.hair === "styleMessy" ? (r.hairargs?.length ?? 9) : 0;
  for (let y = 11; y <= len; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
  for (let y = 4; y <= 12; y++) { set(buf, 4, y, sh); set(buf, 13, y, sh); }
  for (const [x, y] of [[5, 3], [12, 3], [5, 13], [12, 13], [6, 14], [11, 14]]) set(buf, x, y, sh);
  for (const [x, y] of [[7, 2], [8, 2], [9, 2], [10, 2], [7, 3], [8, 3], [9, 3]]) set(buf, x, y, hi);
  for (let y = 4; y <= 11; y++) set(buf, 9, y, hi);
  for (let y = 4; y <= 12; y++) set(buf, 8, y, sh);
  rect(buf, 7, 14, 10, 14, sh); rect(buf, 7, 15, 10, 17, s.sh); rect(buf, 7, 15, 9, 15, s.base);
}

function outlinePass(buf) {
  const pts = [];
  for (let y = 0; y < CUR_H; y++) for (let x = 0; x < CUR_W; x++) {
    if (alphaAt(buf, x, y) !== 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (alphaAt(buf, x + dx, y + dy) === 255) { pts.push([x, y]); break; }
  }
  for (const [x, y] of pts) set(buf, x, y, OUTLINE);
}

function drawHeavyFace(buf, skin) {
  const s = SKIN[skin];
  for (let y = 11; y <= 15; y++) { set(buf, HX0 - 1, y, s.base); set(buf, HX1 + 1, y, s.base); }
  set(buf, HX0 - 1, 15, s.sh); set(buf, HX1 + 1, 15, s.sh);
  for (const x of [5, 6, 11, 12]) set(buf, x, 16, s.base);
  rect(buf, 6, 17, 11, 18, s.base);
  for (const x of [6, 7, 8, 9, 10, 11]) set(buf, x, 18, s.sh);
  set(buf, 7, 17, s.sh); set(buf, 10, 17, s.sh);
}

function drawHeadGroup(buf, r) {
  drawHead(buf, r.skin);
  if (r.heavy) drawHeavyFace(buf, r.skin);
  drawFace(buf, r.skin, r.brow, r.mouth, r.blush, r.lashes);
  if (r.facial) drawFacial(buf, r.facial, r.hairc);
  HAIR[r.hair](buf, r.hairc, SKIN[r.skin].base, r.hairargs || {});
  if (r.glasses) drawGlasses(buf);
}

// ---------------- RedPi: deterministic recipes from name + role ----------------
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const HAIR_COLORS = [[40, 30, 24], [74, 51, 32], [120, 76, 42], [186, 154, 90], [24, 18, 22], [154, 82, 46], [170, 166, 156], [58, 42, 28]];
const STYLES = ["styleShort", "styleFloppy", "styleFrame", "styleBun", "styleCurly", "styleMessy", "styleSpiky", "styleShort", "styleRecede", "styleBald"];
// Role → clothing cut and colours, so a glance at the floor tells who does what.
function roleLook(role) {
  const r = String(role || "").toLowerCase();
  if (r === "ceo") return { cloth: "suit", c1: [34, 44, 38], tie: [214, 48, 64] };
  if (/secur|pentest|red.?team|cyber/.test(r)) return { cloth: "suit", c1: [30, 30, 36], tie: [214, 48, 64] };
  if (/review|qa|test|audit/.test(r)) return { cloth: "cardigan", c1: [196, 150, 60], c2: [236, 232, 220] };
  if (/\bai\b|ml|agent|llm|data/.test(r)) return { cloth: "sweater", c1: [120, 90, 190] };
  if (/front|ui|ux|design/.test(r)) return { cloth: "polo", c1: [40, 170, 200], c2: [26, 130, 160] };
  if (/full.?stack/.test(r)) return { cloth: "polo", c1: [40, 150, 110], c2: [30, 110, 80] };
  if (/devops|infra|sre|platform|ops/.test(r)) return { cloth: "polo", c1: [210, 110, 60], c2: [170, 80, 40] };
  if (/back|api|server/.test(r)) return { cloth: "dressshirt", c1: [70, 150, 100], tie: [30, 70, 50] };
  return { cloth: "dressshirt", c1: [110, 130, 150] };
}

export function recipeFor(name, role, mood = "ok") {
  const h = hash(`${name}|${role}`);
  const pick = (arr, salt) => arr[(h >>> salt) % arr.length];
  const hair = pick(STYLES, 3);
  const long = hair === "styleFrame" || hair === "styleBun" || hair === "styleCurly";
  return {
    skin: pick(["light", "tan", "brown", "dark"], 0),
    hairc: pick(HAIR_COLORS, 7),
    hair,
    hairargs: hair === "styleFrame" ? { length: 16 + ((h >>> 11) % 4), vol: 1 + ((h >>> 13) % 2) } : hair === "styleShort" ? { part: (h >>> 12) % 2 ? "L" : "R" } : {},
    ...roleLook(role),
    glasses: (h >>> 17) % 3 === 0,
    facial: !long && (h >>> 19) % 5 === 0 ? pick(["mustacheSm", "stubble", "goatee"], 21) : undefined,
    lashes: long,
    blush: long && (h >>> 23) % 2 === 0,
    heavy: (h >>> 25) % 7 === 0,
    brow: mood === "blocked" ? "angry" : mood === "working" ? "flat" : pick(["flat", "soft", "raised"], 27),
    mouth: mood === "blocked" ? "frown" : mood === "done" ? "grin" : mood === "working" ? "neutral" : "smile",
  };
}

function toCanvas(buf, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  return c;
}

function composePortrait(r) {
  CUR_W = PORTRAIT_W; CUR_H = PORTRAIT_H;
  const buf = new Uint8ClampedArray(PORTRAIT_W * PORTRAIT_H * 4);
  drawClothing(buf, r);
  rect(buf, 7, 18, 10, 19, SKIN[r.skin].sh);
  drawHeadGroup(buf, r);
  outlinePass(buf);
  return buf;
}

function composeScene(r, phase, back) {
  CUR_W = SCENE_W; CUR_H = SCENE_H;
  const buf = new Uint8ClampedArray(SCENE_W * SCENE_H * 4);
  drawSceneTorso(buf, r, back);
  drawSceneLegs(buf, r.pants || (r.cloth === "suit" ? shades(r.c1)[2] : [54, 56, 70]), phase);
  if (back) drawHeadBack(buf, r); else drawHeadGroup(buf, r);
  outlinePass(buf);
  return buf;
}

const portraitCache = new Map();
const sceneCache = new Map();

/** Canvas with a person's 18×28 portrait (cached per name/role/mood). */
export function portraitCanvas(name, role, mood = "ok") {
  const key = `${name}|${role}|${mood}`;
  if (!portraitCache.has(key)) portraitCache.set(key, toCanvas(composePortrait(recipeFor(name, role, mood)), PORTRAIT_W, PORTRAIT_H));
  return portraitCache.get(key);
}

/** data: URL portrait for <img> in the DOM (CSP allows data: images). */
const urlCache = new Map();
export function portraitUrl(name, role, mood = "ok") {
  const key = `${name}|${role}|${mood}`;
  if (!urlCache.has(key)) {
    const src = portraitCanvas(name, role, mood);
    const big = document.createElement("canvas");
    big.width = PORTRAIT_W * 4; big.height = PORTRAIT_H * 4;
    const ctx = big.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, big.width, big.height);
    urlCache.set(key, big.toDataURL("image/png"));
  }
  return urlCache.get(key);
}

/** Walking frames: { front: [stand, stepL, stepR], back: [...] } as canvases. */
export function sceneFrames(name, role, mood = "ok") {
  const key = `${name}|${role}|${mood}`;
  if (!sceneCache.has(key)) {
    const r = recipeFor(name, role, mood);
    sceneCache.set(key, {
      front: [0, 1, 2].map((p) => toCanvas(composeScene(r, p, false), SCENE_W, SCENE_H)),
      back: [0, 1, 2].map((p) => toCanvas(composeScene(r, p, true), SCENE_W, SCENE_H)),
    });
  }
  return sceneCache.get(key);
}
