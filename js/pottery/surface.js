// 釉面：泥色或釉色 + 纹样 + 开片，画在一张展开的柱面贴图上（横向绕器一周，纵向为器身高度）。
// 纹样按器身“周长 / 高度”压缩横向比例，宽碗、细瓶上的云头与莲花都不会被拉扁。
import { clamp, lerp, rng } from '../util.js';
import { byId, clayOf, GLAZES, INKS } from './model.js';

const TEX = 1024;
const masks = new Map(); // `${pattern}:${k}` → Uint8Array

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 拉坯纹理：横向的细密旋痕 + 颗粒，作为凹凸贴图。 */
function throwingBump(THREE) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 1024;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 1024), r = rng(76123);
  for (let y = 0; y < 1024; y++) {
    const wave = Math.sin(y * 0.83) * 3 + Math.sin(y * 0.205) * 1.6 + Math.sin(y * 0.047) * 2;
    for (let x = 0; x < 256; x++) {
      const v = 128 + wave + (r() - 0.5) * 12, i = (y * 256 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
  return t;
}

// ---------- 纹样遮罩（白 = 着色）。k 为横向压缩比例，motif 个数取整保证首尾无缝 ----------
function drawMask(fn, k) {
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, TEX, TEX);
  g.fillStyle = g.strokeStyle = '#fff';
  g.lineCap = g.lineJoin = 'round';
  for (const off of [-TEX, 0, TEX]) { g.save(); g.translate(off, 0); fn(g, k); g.restore(); }
  const b = document.createElement('canvas');
  b.width = b.height = TEX;
  const bg = b.getContext('2d');
  bg.filter = 'blur(1.4px)';
  bg.drawImage(c, 0, 0);
  const d = bg.getImageData(0, 0, TEX, TEX).data, m = new Uint8Array(TEX * TEX);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4];
  return m;
}
const yOf = (t) => (1 - t) * TEX; // 器身高度比例 → 贴图纵坐标（顶部为 0）
function band(g, ts, w = 3) { g.lineWidth = w; for (const t of ts) { g.beginPath(); g.moveTo(-4, yOf(t)); g.lineTo(TEX + 4, yOf(t)); g.stroke(); } }
function spiral(g, cx, cy, r0, turns, dir = 1) {
  g.beginPath();
  for (let a = 0; a <= turns * Math.PI * 2; a += 0.12) {
    const r = r0 * (1 - a / (turns * Math.PI * 2 + 0.6));
    const x = cx + Math.cos(a * dir) * r, y = cy + Math.sin(a * dir) * r;
    a ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

function paintCloud(g, k) {
  band(g, [0.8, 0.79, 0.2, 0.19]);
  const per = Math.max(3, Math.round(4.5 / (k * 1.6)));
  const rows = [[0.62, 0], [0.4, 0.5]];
  for (const [t, phase] of rows) {
    for (let n = 0; n < per; n++) {
      const x = ((n + phase) / per) * TEX, y = yOf(t), flip = (n + (phase ? 1 : 0)) % 2 ? -1 : 1;
      g.save(); g.translate(x, y); g.scale(k * flip, 1);
      // 三瓣云头：先淡淡填色（青花分水），再勾线
      g.globalAlpha = 0.5;
      g.beginPath(); g.arc(-22, 4, 17, 0, Math.PI * 2); g.arc(0, -10, 19, 0, Math.PI * 2); g.arc(22, 4, 17, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1; g.lineWidth = 5;
      g.beginPath(); g.arc(-22, 4, 17, Math.PI * 0.55, Math.PI * 1.6); g.stroke();
      g.beginPath(); g.arc(0, -10, 19, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      g.beginPath(); g.arc(22, 4, 17, Math.PI * 1.4, Math.PI * 2.45); g.stroke();
      g.lineWidth = 3.5; spiral(g, -22, 4, 11, 1.6); spiral(g, 22, 4, 11, 1.6, -1); spiral(g, 0, -10, 12, 1.7);
      // 云尾
      g.lineWidth = 5;
      g.beginPath(); g.moveTo(-34, 16); g.bezierCurveTo(-80, 40, -130, 6, -175, 28); g.stroke();
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(-30, 24); g.bezierCurveTo(-70, 52, -110, 30, -140, 44); g.stroke();
      g.restore();
    }
  }
}

function paintLotus(g, k) {
  band(g, [0.7, 0.69, 0.18, 0.17]);
  const r = rng(4), y0 = yOf(0.44), A = 62, periods = Math.max(2, Math.round(3 / (k * 1.6)));
  g.lineWidth = 6;
  g.beginPath();
  for (let x = 0; x <= TEX; x += 4) { const y = y0 + A * Math.sin((x / TEX) * Math.PI * 2 * periods); x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  for (let n = 0; n < periods * 2; n++) {
    const x = ((n + 0.25) / (periods * 2)) * TEX, up = n % 2 === 0, y = y0 + (up ? A : -A);
    g.save(); g.translate(x, y + (up ? -10 : 10)); g.scale(k * 1.4, 1);
    for (let p = -2; p <= 2; p++) { g.save(); g.rotate(p * 0.42); g.beginPath(); g.ellipse(0, -36, 13, 38, 0, 0, Math.PI * 2); g.globalAlpha = 0.85; g.fill(); g.restore(); }
    g.globalAlpha = 1; g.beginPath(); g.arc(0, 4, 11, 0, Math.PI * 2); g.fill();
    g.restore();
    for (const s of [-1, 1]) {
      const lx = x + s * 70 * k * 1.4, ly = y0 + (up ? A : -A) * 0.35;
      g.save(); g.translate(lx, ly); g.scale(k * 1.4, 1); g.rotate(s * 0.7 + (up ? 0.3 : -0.3));
      g.beginPath(); g.ellipse(0, 0, 32, 11, 0, 0, Math.PI * 2); g.fill(); g.restore();
      g.save(); g.translate(x + s * 120 * k * 1.4, y0 + (up ? -22 : 22)); g.scale(k * 1.4, 1);
      g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 17 + r() * 6, 0, Math.PI * 1.5); g.stroke(); g.restore();
    }
  }
}

function paintWave(g, k) {
  band(g, [0.36, 0.35, 0.05, 0.04]);
  const w = 64 * k * 1.5, cols = Math.max(8, Math.round(TEX / w)), step = TEX / cols;
  g.lineWidth = 4;
  [0.31, 0.26, 0.21, 0.16, 0.11].forEach((t, row) => {
    const y = yOf(t), off = (row % 2) * (step / 2);
    for (let x = -step + off; x < TEX + step; x += step) {
      for (let kk = 0; kk < 3; kk++) { g.save(); g.translate(x, y); g.scale(step / 64, 1); g.beginPath(); g.arc(0, 0, 30 - kk * 9, Math.PI, Math.PI * 2); g.restore(); g.stroke(); }
    }
  });
  const crests = Math.max(3, Math.round(4 / (k * 1.5)));
  for (let n = 0; n < crests; n++) {
    const x = (n / crests) * TEX;
    g.save(); g.translate(x, yOf(0.33)); g.scale(k * 1.5, 1);
    g.lineWidth = 6; g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(40, -80, 120, -70, 110, -24); g.bezierCurveTo(100, 6, 70, -4, 78, -24); g.stroke();
    g.restore();
  }
}

function paintCrackle(g) {
  const r = rng(12);
  g.lineWidth = 1.3;
  for (let i = 0; i < 640; i++) {
    let x = r() * TEX, y = r() * TEX;
    g.globalAlpha = 0.35 + r() * 0.65;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 3; s++) { x += (r() - 0.5) * 60; y += (r() - 0.5) * 70; g.lineTo(x, y); }
    g.stroke();
  }
  g.globalAlpha = 1;
}

const PAINTERS = { cloud: paintCloud, lotus: paintLotus, wave: paintWave, crackle: paintCrackle };

function maskFor(id, k) {
  const key = id + ':' + k;
  if (!masks.has(key)) {
    if (masks.size > 10) masks.delete(masks.keys().next().value);
    masks.set(key, drawMask(PAINTERS[id], k));
  }
  return masks.get(key);
}

/** 器身周长与高度之比 → 纹样横向压缩比例（量化到 0.05，便于缓存）。 */
function aspectOf(doc, rows) {
  let sum = 0, n = 0;
  for (let i = 20; i < 76; i += 4) { sum += rows[i].reduce((a, b) => a + b, 0) / rows[i].length; n++; }
  const circumference = 2 * Math.PI * (sum / n), height = doc.height / 6;
  return clamp(Math.round((height / circumference) * 1.9 * 20) / 20, 0.15, 1.2);
}

/** 纹样缩略图（施釉面板用）。 */
export function patternThumb(id, doc) {
  const c = document.createElement('canvas');
  c.width = c.height = 72;
  const g = c.getContext('2d');
  const base = doc.glaze === 'none' ? hexRgb(clayOf(doc.material).color) : byId(GLAZES, doc.glaze).rgb, ink = byId(INKS, doc.ink).rgb;
  g.fillStyle = `rgb(${base})`; g.fillRect(0, 0, 72, 72);
  if (id !== 'plain') {
    const m = maskFor(id, 0.5), img = g.getImageData(0, 0, 72, 72);
    const t0 = { cloud: 0.32, lotus: 0.26, wave: 0.02 }[id];
    for (let y = 0; y < 72; y++) for (let x = 0; x < 72; x++) {
      const sy = Math.floor(yOf(t0 + 0.5) + y * 7.2), sx = Math.floor(x * 6) % TEX;
      const a = (m[sy * TEX + sx] / 255) * 0.92, i = (y * 72 + x) * 4;
      for (let ch = 0; ch < 3; ch++) img.data[i + ch] = lerp(img.data[i + ch], ink[ch], a);
    }
    g.putImageData(img, 0, 0);
  }
  return c;
}

export function createSurface(THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.anisotropy = 8;
  const bump = throwingBump(THREE);
  const grain = new Float32Array(TEX * TEX);
  { const r = rng(9); for (let i = 0; i < grain.length; i++) grain[i] = r(); }

  const outer = new THREE.MeshPhysicalMaterial({ map, bumpMap: bump, roughness: 0.8, metalness: 0, envMapIntensity: 0.55 });
  const inner = new THREE.MeshPhysicalMaterial({ color: 0xffffff, bumpMap: bump, roughness: 0.85, metalness: 0, envMapIntensity: 0.4, side: THREE.DoubleSide });
  let lastKey = '';

  function composite(doc, k) {
    const glazed = doc.glaze !== 'none';
    const clay = hexRgb(clayOf(doc.material).color);
    const base = glazed ? byId(GLAZES, doc.glaze).rgb : clay;
    const ink = byId(INKS, doc.ink).rgb;
    const mask = doc.pattern === 'plain' ? null : maskFor(doc.pattern, k);
    const crack = glazed && doc.crackle ? maskFor('crackle', 1) : null;
    const dark = glazed && (base[0] + base[1] + base[2]) < 240; // 深色釉上的开片显浅色
    const img = ctx.createImageData(TEX, TEX), d = img.data;
    const inkA = doc.ink === 'gold' ? 0.88 : 0.92;
    for (let y = 0; y < TEX; y++) {
      const t = 1 - y / TEX;
      // 施釉时圈足留一圈露胎；釉在下腹略厚、色略深
      const foot = glazed ? clamp((t - 0.012) / 0.018) : 1;
      const pool = glazed ? 1 - 0.07 * clamp(1 - (t - 0.04) / 0.3) : 1;
      for (let x = 0; x < TEX; x++) {
        const i = y * TEX + x, n = grain[i];
        const v = glazed ? pool * (0.985 + n * 0.03) : 0.93 + n * 0.12;
        let r = base[0] * v, g = base[1] * v, b = base[2] * v;
        if (mask) {
          const m = (mask[i] / 255) * inkA, depth = 0.86 + n * 0.1;
          r = lerp(r, ink[0] * depth, m); g = lerp(g, ink[1] * depth, m); b = lerp(b, ink[2] * depth, m);
        }
        if (crack) {
          const c = crack[i] / 255;
          if (dark) { r += c * 40; g += c * 34; b += c * 26; } else { const f = 1 - c * 0.3; r *= f; g *= f; b *= f; }
        }
        if (foot < 1) { r = lerp(clay[0], r, foot); g = lerp(clay[1], g, foot); b = lerp(clay[2], b, foot); }
        const o = i * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    map.needsUpdate = true;
  }

  function finish(doc) {
    const glazed = doc.glaze !== 'none', q = doc.gloss / 100;
    const base = glazed ? byId(GLAZES, doc.glaze).rgb : hexRgb(clayOf(doc.material).color);
    for (const m of [outer, inner]) {
      m.roughness = glazed ? 0.55 - q * 0.4 : 0.95 - q * 0.45;
      m.clearcoat = glazed ? 0.25 + q * 0.65 : q * 0.15;
      m.clearcoatRoughness = glazed ? 0.4 - q * 0.3 : 0.6;
      m.bumpScale = glazed ? 0.15 : 1.1;
    }
    inner.color.setRGB(...base.map((c) => (c / 255) * 0.9), THREE.SRGBColorSpace);
  }

  return {
    outer, inner, canvas,
    /** 文档变化后调用；只有釉、纹样或器身比例变化时才重画贴图。 */
    update(doc, rows) {
      const k = aspectOf(doc, rows);
      const key = [doc.material, doc.glaze, doc.pattern, doc.ink, doc.crackle, doc.pattern === 'plain' ? 0 : k].join('|');
      if (key !== lastKey) { lastKey = key; composite(doc, k); }
      finish(doc);
    },
  };
}
