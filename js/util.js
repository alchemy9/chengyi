// 通用小工具：缓动、插值、覆盖式缩放、图片加载、设置存储

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a));
export const smooth = (a, b, v) => { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); };
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t) => t * t * t;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 以 cover 方式把 W×H 的设计画面铺满视口，返回缩放与偏移（视口坐标 = 设计坐标 * s + x）。 */
export function cover(vw, vh, W, H, fx = 0.5, fy = 0.5) {
  const s = Math.max(vw / W, vh / H);
  return { s, x: (vw - W * s) * fx, y: (vh - H * s) * fy };
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败：' + src));
    img.src = src;
  });
}

/** 简单的确定性伪随机，保证滚动回看时粒子位置一致。 */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Catmull-Rom 曲线采样，pts: [[x,y],...]，返回带累计长度的稠密点。 */
export function sampleSpline(pts, perSeg = 16) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1].slice());
  let L = 0;
  out[0][2] = 0;
  for (let i = 1; i < out.length; i++) {
    L += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
    out[i][2] = L;
  }
  return { pts: out, length: L };
}

/** 在稠密曲线上按 0..1 取点，返回 [x, y, 切线角]。 */
export function pointAt(curve, u) {
  const d = clamp(u) * curve.length, p = curve.pts;
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][2] < d) lo = m; else hi = m; }
  const a = p[lo], b = p[hi], seg = (b[2] - a[2]) || 1, t = (d - a[2]) / seg;
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), Math.atan2(b[1] - a[1], b[0] - a[0])];
}

/** 多关键帧插值：keys 为 [[p, x, y], ...] 按 p 升序，用 Catmull-Rom 平滑。 */
export function keyPath(keys, p) {
  if (p <= keys[0][0]) return [keys[0][1], keys[0][2]];
  const n = keys.length;
  if (p >= keys[n - 1][0]) return [keys[n - 1][1], keys[n - 1][2]];
  let i = 0;
  while (i < n - 2 && keys[i + 1][0] < p) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const t = (p - k1[0]) / (k2[0] - k1[0]), t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(k0[1], k1[1], k2[1], k3[1]), f(k0[2], k1[2], k2[2], k3[2])];
}

/** 预渲染一个柔光圆点，绘制大量粒子时用 drawImage 比 arc+shadow 快得多。 */
export function glowSprite(rgb = '255,214,150', size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(${rgb},1)`);
  grd.addColorStop(0.18, `rgba(${rgb},0.85)`);
  grd.addColorStop(0.45, `rgba(${rgb},0.22)`);
  grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

/** 让 canvas 尺寸跟随元素与设备像素比。返回是否发生变化。 */
export function fitCanvas(canvas, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
  return false;
}

/** 本地设置：读写都包在 try/catch 里，隐私模式下也不会报错。 */
export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem('chengyi3.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('chengyi3.' + key, JSON.stringify(value)); } catch { /* 忽略 */ }
  },
};

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 基于 rAF 的补间，返回 Promise；cancel() 可中断。 */
export function tween(ms, onUpdate, ease = easeInOut) {
  let raf, cancelled = false, resolveFn;
  const p = new Promise((resolve) => {
    resolveFn = resolve;
    const t0 = performance.now();
    const step = (now) => {
      if (cancelled) return resolve(false);
      const t = Math.min(1, (now - t0) / Math.max(1, ms));
      onUpdate(ease(t), t);
      if (t < 1) raf = requestAnimationFrame(step); else resolve(true);
    };
    raf = requestAnimationFrame(step);
  });
  p.cancel = () => { cancelled = true; cancelAnimationFrame(raf); resolveFn(false); };
  return p;
}
