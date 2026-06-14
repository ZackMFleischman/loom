// Generates the pho-nebula garnish sprites (content/assets/pho/*.png).
// Each sprite is an SDF shader evaluated per pixel with 3x3 supersampling —
// rerun with `node scripts/gen-pho-sprites.mjs` after tweaking shapes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "content", "assets", "pho");
mkdirSync(OUT, { recursive: true });

const len = (x, y) => Math.hypot(x, y);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const sdCircle = (x, y, cx, cy, r) => len(x - cx, y - cy) - r;
// Capsule from a->b with radius r.
function sdSeg(x, y, ax, ay, bx, by, r) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = clamp01((px * dx + py * dy) / (dx * dx + dy * dy || 1));
  return len(px - dx * t, py - dy * t) - r;
}
// Quadratic bezier capsule with radius tapering r0 -> r1 (sampled).
function sdBend(x, y, p0, p1, p2, r0, r1, steps = 24) {
  let best = Infinity;
  let prev = p0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const a = 1 - t;
    const px = a * a * p0[0] + 2 * a * t * p1[0] + t * t * p2[0];
    const py = a * a * p0[1] + 2 * a * t * p1[1] + t * t * p2[1];
    const r = r0 + (r1 - r0) * t;
    best = Math.min(best, sdSeg(x, y, prev[0], prev[1], px, py, r));
    prev = [px, py];
  }
  return best;
}

// shade(x, y) -> [r, g, b, a] with x,y in [-1, 1]; renders w x h supersampled.
function render(name, w, h, shade) {
  const png = new PNG({ width: w, height: h });
  const SS = 3;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / w) * 2 - 1;
          const y = 1 - ((py + (sy + 0.5) / SS) / h) * 2;
          const c = shade(x * (w / h), y); // aspect-corrected x
          r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
        }
      }
      const n = SS * SS;
      const i = (py * w + px) * 4;
      // un-premultiply back to straight alpha for the PNG
      const A = a / n;
      png.data[i] = A > 0 ? Math.round((r / n / A) * 255) : 0;
      png.data[i + 1] = A > 0 ? Math.round((g / n / A) * 255) : 0;
      png.data[i + 2] = A > 0 ? Math.round((b / n / A) * 255) : 0;
      png.data[i + 3] = Math.round(A * 255);
    }
  }
  writeFileSync(join(OUT, name), PNG.sync.write(png));
  console.log(`wrote ${name}`);
}

// Garnish shades render to their own PNG *and* a cell of garnish-atlas.png
// (one texture for spriteSwarm — many sprites, one sampler).
const GARNISH_SHADES = [];
function garnish(name, shade) {
  GARNISH_SHADES.push(shade);
  render(name, 128, 128, shade);
}
function renderAtlas(name, cols, rows, cell) {
  const png = new PNG({ width: cols * cell, height: rows * cell });
  const SS = 3;
  for (let py = 0; py < png.height; py++) {
    for (let px = 0; px < png.width; px++) {
      const shade = GARNISH_SHADES[Math.floor(py / cell) * cols + Math.floor(px / cell)];
      let r = 0, g = 0, b = 0, a = 0;
      if (shade) {
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = (((px % cell) + (sx + 0.5) / SS) / cell) * 2 - 1;
            const y = 1 - (((py % cell) + (sy + 0.5) / SS) / cell) * 2;
            const c = shade(x, y);
            r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
          }
        }
      }
      const n = SS * SS;
      const i = (py * png.width + px) * 4;
      const A = a / n;
      png.data[i] = A > 0 ? Math.round((r / n / A) * 255) : 0;
      png.data[i + 1] = A > 0 ? Math.round((g / n / A) * 255) : 0;
      png.data[i + 2] = A > 0 ? Math.round((b / n / A) * 255) : 0;
      png.data[i + 3] = Math.round(A * 255);
    }
  }
  writeFileSync(join(OUT, name), PNG.sync.write(png));
  console.log(`wrote ${name}`);
}

const AA = 0.03; // edge softness in sprite units
const cov = (d) => clamp01(0.5 - d / AA);
// Layer list: last entry whose sdf covers wins (painter's order).
function paint(layers) {
  let out = [0, 0, 0, 0];
  for (const [d, col] of layers) {
    const a = cov(d);
    if (a <= 0) continue;
    const A = a * (col[3] ?? 1);
    out = [
      col[0] * A + out[0] * (1 - A),
      col[1] * A + out[1] * (1 - A),
      col[2] * A + out[2] * (1 - A),
      A + out[3] * (1 - A),
    ];
  }
  return out;
}
const C = (r, g, b, a = 1) => [r / 255, g / 255, b / 255, a];

// --- chili pepper: curved tapering red body, green stem ---
garnish("chili.png", (x, y) => {
  const body = sdBend(x, y, [-0.55, 0.25], [0.15, 0.55], [0.62, -0.45], 0.2, 0.035);
  const shine = sdBend(x, y, [-0.45, 0.36], [0.1, 0.6], [0.45, 0.0], 0.05, 0.02);
  const stem = sdBend(x, y, [-0.55, 0.25], [-0.72, 0.42], [-0.85, 0.38], 0.07, 0.04);
  return paint([
    [stem, C(72, 140, 52)],
    [body, C(214, 40, 34)],
    [shine, C(245, 110, 90, 0.8)],
  ]);
});

// --- lime slice: rind ring, pith, pale flesh, radial segment lines ---
garnish("lime.png", (x, y) => {
  const R = 0.8;
  const disc = sdCircle(x, y, 0, 0, R);
  const pith = sdCircle(x, y, 0, 0, R * 0.88);
  const flesh = sdCircle(x, y, 0, 0, R * 0.8);
  const layers = [
    [disc, C(58, 128, 40)],
    [pith, C(235, 245, 218)],
    [flesh, C(186, 224, 130)],
  ];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    layers.push([
      sdSeg(x, y, Math.cos(a) * 0.1, Math.sin(a) * 0.1, Math.cos(a) * R * 0.76, Math.sin(a) * R * 0.76, 0.02),
      C(235, 245, 218),
    ]);
  }
  layers.push([sdCircle(x, y, 0, 0, 0.07), C(235, 245, 218)]);
  return paint(layers);
});

// --- scallion ring: pale annulus with green rim ---
garnish("scallion.png", (x, y) => {
  const outer = sdCircle(x, y, 0, 0, 0.62);
  const body = sdCircle(x, y, 0, 0, 0.55);
  const hole = sdCircle(x, y, 0, 0, 0.3);
  const ring = paint([
    [outer, C(110, 175, 75)],
    [body, C(228, 242, 210)],
  ]);
  const cut = cov(hole);
  return [ring[0], ring[1], ring[2], ring[3] * (1 - cut * 0.92)];
});

// --- star anise: 8 brown petals with seed-pod dots ---
garnish("anise.png", (x, y) => {
  const layers = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39;
    const cx = Math.cos(a), cy = Math.sin(a);
    layers.push([sdSeg(x, y, cx * 0.12, cy * 0.12, cx * 0.68, cy * 0.68, 0.13), C(92, 54, 26)]);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39;
    layers.push([sdCircle(x, y, Math.cos(a) * 0.52, Math.sin(a) * 0.52, 0.07), C(196, 152, 88)]);
  }
  layers.push([sdCircle(x, y, 0, 0, 0.16), C(120, 74, 36)]);
  return paint(layers);
});

// --- basil leaf: pointed leaf with veins and a stub of stem ---
garnish("basil.png", (x, y) => {
  // leaf = intersection of two offset discs, tip to the right
  const dA = sdCircle(x, y, -0.15, 0.42, 0.95);
  const dB = sdCircle(x, y, -0.15, -0.42, 0.95);
  const leaf = Math.max(dA, dB);
  const stem = sdSeg(x, y, -0.95, 0, -0.65, 0, 0.045);
  const inLeaf = (d) => Math.max(d, leaf + 0.04); // clip veins inside the leaf
  const layers = [
    [stem, C(60, 120, 55)],
    [leaf, C(52, 138, 64)],
    [inLeaf(sdSeg(x, y, -0.65, 0, 0.72, 0, 0.022)), C(125, 192, 125)],
  ];
  for (let i = 0; i < 4; i++) {
    const t = -0.45 + i * 0.3;
    for (const s of [1, -1]) {
      layers.push([inLeaf(sdSeg(x, y, t, 0, t + 0.28, s * 0.26, 0.013)), C(125, 192, 125, 0.8)]);
    }
  }
  return paint(layers);
});

// --- chopsticks: two tapering wooden sticks, crossed slightly ---
garnish("chopsticks.png", (x, y) => {
  const stickA = sdBend(x, y, [-0.8, -0.62], [0, -0.12], [0.82, 0.42], 0.062, 0.028);
  const stickB = sdBend(x, y, [-0.84, -0.3], [0, 0.12], [0.8, 0.62], 0.062, 0.028);
  const tipA = sdSeg(x, y, 0.62, 0.32, 0.82, 0.42, 0.034);
  const tipB = sdSeg(x, y, 0.6, 0.52, 0.8, 0.62, 0.034);
  return paint([
    [stickA, C(206, 160, 102)],
    [tipA, C(158, 108, 58)],
    [stickB, C(216, 174, 118)],
    [tipB, C(158, 108, 58)],
  ]);
});

// --- the PHỞ badge: blobby bitmap glyphs, cream on a warm red outline ---
const P = ["###.", "#..#", "#..#", "###.", "#...", "#...", "#..."];
const H = ["#..#", "#..#", "#..#", "####", "#..#", "#..#", "#..#"];
const O_HORN = [".##.#", "#..##", "#..#.", "#..#.", "#..#.", "#..#.", ".##.."]; // Ơ: horn top-right
const HOOK = [".##", "..#", ".#."]; // dấu hỏi above the Ơ
function badgeGrid() {
  const cols = 4 + 1 + 4 + 1 + 5; // P _ H _ Ơ
  const rows = 4 + 7; // hook rows + gap, then letters
  const grid = Array.from({ length: rows }, () => Array(cols).fill(false));
  const blit = (art, r0, c0) =>
    art.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === "#") grid[r0 + r][c0 + c] = true; }));
  blit(HOOK, 0, 11); // centered over the O bowl
  blit(P, 4, 0);
  blit(H, 4, 5);
  blit(O_HORN, 4, 10);
  return grid;
}
render("pho-badge.png", 480, 352, (x, y) => {
  const grid = badgeGrid();
  const rows = grid.length, cols = grid[0].length;
  const cell = 1.84 / Math.max(cols, rows); // fit with margin
  let d = Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!grid[r][c]) continue;
      const cx = (c - (cols - 1) / 2) * cell;
      const cy = ((rows - 1) / 2 - r) * cell;
      d = Math.min(d, sdCircle(x, y, cx, cy, cell * 0.62));
    }
  }
  return paint([
    [d - 0.1, C(170, 30, 25, 0.35)], // soft warm halo
    [d - 0.045, C(196, 44, 32)], // outline
    [d, C(255, 240, 212)], // cream fill
  ]);
});

renderAtlas("garnish-atlas.png", 3, 2, 128);
