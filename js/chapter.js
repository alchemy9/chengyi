// 陶瓷篇章「从土成器，归土承艺」：一条连续的滚动时间轴（0..1），向下推进、向上回溯。
// 每幕有进入、展示、离开三段；背景、主体、文字、雾与近景粒子各自不同速，形成纵深。
import { $, clamp, cover, lerp, smooth, keyPath, glowSprite, loadImage, rng, fitCanvas } from './util.js';
import { ACTS, STORY_VIDEOS } from './data.js';

const SW = 1672, SH = 941;
const SCROLL_LEN = 15000; // 走完全篇所需的滚轮距离（像素）
const S = 'assets/story/';

let app, root, stage, fx, fctx, textRoot, indexEl, hint, endEl;
let P = 0, Pt = 0, raf = 0, last = 0, running = false, loaded = false, touched = false;
let stageT = { s: 1, x: 0, y: 0 };
let trail = [];
const mouse = { x: 0, y: 0, sx: 0, sy: 0 }; // 鼠标视差：只影响画面，不影响文字与时间轴
const acts = {};
const imgs = {};
const gold = glowSprite('255,212,140');
const clayDot = glowSprite('226,200,160');
const fogSp = glowSprite('120,150,150', 128);

// 引导光点关键帧（设计坐标），贯穿全篇
const LIGHT = [
  [0, 836, -60], [0.03, 760, 250], [0.07, 560, 340], [0.1, 300, 470], [0.13, 660, 560], [0.17, 1000, 380],
  [0.21, 1420, 470], [0.25, 1150, 650], [0.29, 760, 330], [0.33, 560, 230], [0.37, 820, 560], [0.42, 1020, 380],
  [0.46, 1120, 350], [0.5, 760, 420], [0.54, 880, 520], [0.585, 1140, 470], [0.62, 1300, 300], [0.66, 1000, 170],
  [0.7, 830, 120], [0.74, 1060, 280], [0.79, 1150, 360], [0.84, 1000, 600], [0.89, 800, 800], [0.925, 836, 260],
  [0.96, 836, 470], [1, 836, 560],
];
// 窄屏时各幕的取景重心（0..1）
const FOCUS = [[0, 0.32], [0.14, 0.7], [0.26, 0.33], [0.38, 0.68], [0.55, 0.68], [0.68, 0.5], [0.8, 0.62], [0.92, 0.5]];

const el = (tag, cls, parent, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; parent?.appendChild(e); return e; };
const layer = (parent, src, cls = 'ch-layer') => { const i = el('img', cls, parent); i.dataset.src = src; i.alt = ''; return i; };
function sub(parent, src, x, y, w, h) {
  const d = el('div', 'ch-sub', parent);
  d.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
  const i = el('img', '', d); i.dataset.src = src; i.alt = '';
  return d;
}
function style(e, { x = 0, y = 0, s = 1, sx, sy, r = 0, o = 1, blur = 0, origin } = {}) {
  if (!e) return;
  if (origin) e.style.transformOrigin = origin;
  const sc = sx !== undefined ? `scale(${sx}, ${sy})` : `scale(${s})`;
  e.style.transform = `translate3d(${x}px, ${y}px, 0) ${sc}${r ? ` rotate(${r}deg)` : ''}`;
  e.style.opacity = o.toFixed(3);
  e.style.filter = blur > 0.2 ? `blur(${blur.toFixed(1)}px)` : 'none';
}
const local = (a, b, ov = 0.03) => clamp((P - (a - ov)) / (b - a + 2 * ov));
// 通用镜头：从深处靠近（放大、清晰），离开时继续放大、虚化、淡出——镜头穿过当前场景
function cam(t) {
  const en = smooth(0, 0.24, t), ex = smooth(0.76, 1, t), hold = smooth(0.24, 0.76, t);
  return { en, ex, hold, s: lerp(0.8, 1, en) * lerp(1, 1.45, ex) * (1 + 0.025 * hold), o: en * (1 - ex), blur: (1 - en) * 2.5 + ex * 3 };
}
function textBlock(act, cls) {
  const b = el('div', `ch-block ${cls}`, textRoot);
  b.innerHTML = `<h2>${act.title}</h2><i class="rule"></i>` + (act.body ? `<p>${act.body.join('<br>')}</p>` : '');
  return b;
}
function textStyle(b, t, inDir, outDir) {
  const i = smooth(0.14, 0.32, t), o = smooth(0.74, 0.92, t);
  const narrow = innerWidth < 900;
  const base = narrow ? 'translateX(-50%) ' : '';
  b.style.transform = `${base}translate3d(${(1 - i) * inDir * 50 + o * outDir * 280}px, 0, 0) scale(${lerp(0.94, 1, i) * lerp(1, 1.06, o)})`;
  b.style.opacity = (i * (1 - o)).toFixed(3);
  b.style.filter = o > 0.05 ? `blur(${o * 3}px)` : 'none';
}

function build() {
  stage.innerHTML = '';
  textRoot.innerHTML = '';
  // 壹 择土
  {
    const a = ACTS[0], c = el('div', 'ch-act', stage);
    acts.soil = { c, bg: layer(c, S + 's1-plate.jpg'), full: layer(c, S + 's1.jpg'), heap: sub(c, S + 'cut-heap.png', 90, 290, 780, 410), text: textBlock(a, 'right') };
  }
  // 贰 练泥
  {
    const a = ACTS[1], c = el('div', 'ch-act', stage);
    acts.clay = { c, bg: layer(c, S + 's2-plate.jpg'), full: layer(c, S + 's2.jpg'), clay: sub(c, S + 'cut-clay.png', 940, 290, 470, 440), text: textBlock(a, 'left') };
  }
  // 叁 成形：瓶身光影随转动掠过
  {
    const a = ACTS[2], c = el('div', 'ch-act', stage);
    const v = sub(c, S + 'cut-biscuit.png', 385, 225, 365, 505);
    const shine = el('div', 'ch-shine', v);
    shine.style.webkitMaskImage = shine.style.maskImage = `url(${S}cut-biscuit.png)`;
    acts.form = { c, bg: layer(c, S + 's3-plate.jpg'), full: layer(c, S + 's3.jpg'), vase: v, shine, text: textBlock(a, 'right') };
  }
  // 肆 施釉：远景瓶 → 推进到瓶身特写，三条引线依次出现
  {
    const a = ACTS[3], c = el('div', 'ch-act', stage);
    const far = el('div', 'ch-layer', c);
    const farBg = layer(far, S + 's4-plate.jpg');
    const farVase = sub(far, S + 'cut-vase4.png', 1030, 280, 220, 300);
    const farFull = layer(far, S + 's4.jpg'); // 施釉完成后换成原图（带瓶身辉光），推近时不缺光晕
    farFull.style.zIndex = 3;
    const near = el('div', 'ch-layer', c);
    layer(near, S + 's5.jpg');
    const svg = el('div', 'ch-svg', near);
    const notes = [[445, 376, 875, 425], [445, 522, 850, 568], [445, 670, 832, 722]];
    svg.innerHTML = `<svg viewBox="0 0 ${SW} ${SH}" width="${SW}" height="${SH}">${notes.map(([x, y, ex, ey], i) =>
      `<g class="note" data-i="${i}"><path d="M ${x + 180} ${y} H ${x + 275} L ${ex} ${ey}" fill="none" stroke="rgba(230,214,180,.75)" stroke-width="1.2" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/><circle cx="${ex}" cy="${ey}" r="4" fill="#f4dcaa"/></g>`).join('')}</svg>`;
    const noteEls = notes.map(([x, y], i) => { const n = el('span', 'ch-note', near, a.notes[i]); n.style.cssText = `left:${x}px;top:${y - 14}px`; return n; });
    const t = textBlock({ title: a.title }, 'left');
    t.style.top = '26%';
    acts.glaze = { c, far, farBg, farVase, farFull, near, svg, noteEls, text: t };
  }
  // 伍 入窑：光环依次增强，暖光照亮薄雾
  {
    const a = ACTS[4], c = el('div', 'ch-act', stage);
    const bg = layer(c, S + 's6.jpg');
    const heat = el('div', 'ch-glow', c);
    heat.style.cssText = 'left:840px;top:170px;width:600px;height:600px;background:radial-gradient(closest-side, rgba(255,186,110,.55), rgba(255,140,60,.18) 55%, transparent);mix-blend-mode:screen';
    const rings = el('div', 'ch-svg', c);
    rings.innerHTML = `<svg viewBox="0 0 ${SW} ${SH}" width="${SW}" height="${SH}"><g fill="none" stroke="rgba(255,222,170,.85)">${[170, 290, 430].map((r, i) =>
      `<ellipse cx="1140" cy="470" rx="${r}" ry="${r * 0.94}" stroke-width="${1.6 - i * 0.3}" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="filter:drop-shadow(0 0 6px rgba(255,200,130,.8))"/>`).join('')}</g></svg>`;
    const plate = layer(c, S + 's6-plate.jpg'); // 窑中瓶被“取出”后的底图
    c.insertBefore(plate, bg.nextSibling);
    acts.kiln = { c, bg, plate, heat, rings: [...rings.querySelectorAll('ellipse')], text: textBlock(a, 'left') };
  }
  // 陆 成器 + 柒 消解归土：同一只瓶，先居中展示，再移到右侧，从右向左破碎化泥
  {
    const c = el('div', 'ch-act', stage);
    const bg = layer(c, S + 's7-plate.jpg');
    const bg2 = layer(c, S + 's8-plate.jpg'); // 瓶移走后的纯背景（取自图 8）
    const glow = el('div', 'ch-glow', c);
    glow.style.cssText = 'left:520px;top:120px;width:620px;height:720px;background:radial-gradient(closest-side, rgba(255,226,170,.42), rgba(255,210,150,.12) 60%, transparent)';
    const pile = sub(c, S + 'cut-pile8.png', 560, 680, 400, 220);
    const vase = sub(c, S + 'vase-final.png', 606, 166, 434, 640);
    const t = el('div', 'ch-block top', textRoot, '<h2>完成作品</h2><i class="rule"></i>');
    acts.finish = { c, bg, bg2, glow, pile, vase, text: t };
  }
  // 捌 承艺：空台，泥土落下逐渐堆积，流程线依次出现
  {
    const a = ACTS[7], c = el('div', 'ch-act', stage);
    const bg = layer(c, S + 's9.jpg');
    const heap = sub(c, S + 'cut-heap9.png', 560, 450, 550, 250);
    const t = el('div', 'ch-block top', textRoot, '<h2>承　艺</h2><i class="rule"></i>');
    t.querySelector('h2').style.cssText = 'font-size:28px;letter-spacing:.5em';
    const steps = el('div', 'ch-steps', textRoot, a.steps.map((s) => `<div class="ch-step"><i></i>${s}</div>`).join(''));
    acts.legacy = { c, bg, heap, text: t, steps: [...steps.children] };
  }
  // 篇章索引
  indexEl.innerHTML = ACTS.map((a, i) => `<button data-i="${i}"><span>${a.num} · ${a.title.split(' · ')[0].replace('完成作品', '成器').replace('消解', '归土')}</span><i></i></button>`).join('');
  indexEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const a = ACTS[+b.dataset.i];
    Pt = a.range[0] + (a.range[1] - a.range[0]) * (a.id === 'legacy' ? 1 : 0.45);
    touched = true; hint.classList.add('off');
  }));
}

let readyP = null;
let videos = []; // 已就位的过场视频：{ v, range, el }

async function probeVideos() {
  // assets/story/video/index.json 列出已放入的视频文件名（由 tools/encode_scrub.sh 自动登记）
  let list = [];
  try { list = await (await fetch('assets/story/video/index.json', { cache: 'no-cache' })).json(); } catch { list = []; }
  const names = new Set(Array.isArray(list) ? list : []);
  for (const it of STORY_VIDEOS.filter((x) => names.has(x.src.split('/').pop()))) {
    const v = document.createElement('video');
    v.className = 'ch-layer ch-video';
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = it.src;
    v.style.opacity = 0;
    stage.appendChild(v);
    // 先播放一下再暂停，让浏览器开始解码，之后按进度跳帧才会生效
    v.addEventListener('loadeddata', () => { v.play().then(() => v.pause()).catch(() => {}); }, { once: true });
    const rec = { v, range: it.range, want: 0, busy: false };
    v.addEventListener('seeked', () => { rec.busy = false; if (Math.abs(v.currentTime - rec.want) > 1 / 40) seekTo(rec); });
    videos.push(rec);
  }
}

function seekTo(rec) {
  rec.busy = true;
  rec.v.currentTime = rec.want;
}

/** 视频随滚动进度逐帧播放；区间两端淡入淡出，与前后幕的定格画面衔接。返回当前是否有视频盖住画面。 */
function updateVideos() {
  let active = false;
  for (const rec of videos) {
    const { v, range: [a, b] } = rec;
    const on = P > a && P < b && v.readyState >= 2;
    if (!on) { if (v.style.opacity !== '0') v.style.opacity = 0; continue; }
    const k = (P - a) / (b - a);
    rec.want = Math.min(k * (v.duration || 0), (v.duration || 0) - 0.01);
    // 上一次跳帧完成后再跳下一次，避免请求堆积
    if (!rec.busy && Math.abs(v.currentTime - rec.want) > 1 / 40) seekTo(rec);
    const o = Math.min(1, k / 0.08, (1 - k) / 0.08);
    v.style.opacity = o.toFixed(3);
    if (o > 0.5) active = true;
  }
  textRoot.classList.toggle('video-on', active);
  return active;
}
function loadAssets() {
  if (!readyP) readyP = doLoad();
  return readyP;
}
async function doLoad() {
  loaded = true;
  probeVideos();
  const all = [...root.querySelectorAll('img[data-src]')].map((i) => new Promise((res) => {
    i.onload = () => { i.classList.add('ok'); res(); };
    i.onerror = res;
    i.src = i.dataset.src;
  }));
  const list = ['cut-heap.png', 'vase-final.png'];
  await Promise.all(list.map(async (f) => { try { imgs[f] = await loadImage(S + f); } catch { /* 忽略 */ } }));
  prepGather();
  prepShatter();
  await Promise.all(all);
}

// ---------- 择土：远处土粒向镜头靠近，聚成土堆 ----------
let gather = [];
function prepGather() {
  const img = imgs['cut-heap.png'];
  if (!img) return;
  const c = document.createElement('canvas'), w = 195, h = 102;
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, r = rng(21), pts = [];
  for (let k = 0; k < 6000 && pts.length < 420; k++) {
    const x = (r() * w) | 0, y = (r() * h) | 0;
    if (d[(y * w + x) * 4 + 3] > 120) pts.push({ tx: 90 + x * 4, ty: 290 + y * 4, sx: 836 + (r() - 0.5) * 1600, sy: 470 + (r() - 0.5) * 900, d: r() * 0.35, sz: 0.6 + r() * 1.6 });
  }
  gather = pts;
}

// ---------- 消解：瓶体切成碎片，从右向左依次剥离 ----------
let shards = [], shardCanvas = null;
const VASE_H = 400;
/** 把瓶体切成不规则的维诺碎片，每片预先渲染成带透明边的小图（带一道细亮边，像瓷片的断面）。 */
function prepShatter() {
  const img = imgs['vase-final.png'];
  if (!img) return;
  const h = VASE_H, w = Math.round(img.width / img.height * h);
  shardCanvas = document.createElement('canvas');
  shardCanvas.width = w; shardCanvas.height = h;
  const g = shardCanvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h);
  const d = src.data, r = rng(8);
  // 种子点：抖动网格，右侧（先碎的一侧）更细碎
  const seeds = [];
  for (let y = 6; y < h; y += 17) for (let x = 6; x < w; x += 17) {
    const sx = Math.min(w - 1, x + (r() - 0.5) * 14) | 0, sy = Math.min(h - 1, y + (r() - 0.5) * 14) | 0;
    if (d[(sy * w + sx) * 4 + 3] > 60) seeds.push([sx, sy]);
    if (x > w * 0.55 && r() < 0.5) {
      const tx = Math.min(w - 1, x + (r() - 0.5) * 16) | 0, ty = Math.min(h - 1, y + (r() - 0.5) * 16) | 0;
      if (d[(ty * w + tx) * 4 + 3] > 60) seeds.push([tx, ty]);
    }
  }
  // 最近种子（只搜邻近格子）
  const cell = 17, gx = Math.ceil(w / cell) + 1, grid = new Map();
  seeds.forEach((p, i) => { const k = ((p[1] / cell) | 0) * gx + ((p[0] / cell) | 0); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const label = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] < 8) continue;
    const cx = (x / cell) | 0, cy = (y / cell) | 0;
    let best = -1, bd = 1e9;
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      const list = grid.get((cy + oy) * gx + cx + ox);
      if (!list) continue;
      for (const i of list) { const dx = seeds[i][0] - x, dy = seeds[i][1] - y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = i; } }
    }
    label[y * w + x] = best;
  }
  const box = seeds.map(() => [1e9, 1e9, -1, -1]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = label[y * w + x]; if (l < 0) continue;
    const b = box[l]; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  shards = [];
  seeds.forEach((p, i) => {
    const [x0, y0, x1, y1] = box[i];
    if (x1 < 0) return;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh;
    const cg = cv.getContext('2d');
    const plain = document.createElement('canvas'); plain.width = bw; plain.height = bh;
    const pg = plain.getContext('2d');
    const id = cg.createImageData(bw, bh), o = id.data;
    const pd = pg.createImageData(bw, bh), po = pd.data;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (label[y * w + x] !== i) continue;
      const si = (y * w + x) * 4, di = ((y - y0) * bw + (x - x0)) * 4;
      // 断面：碎片边缘一像素提亮
      const edge = label[y * w + Math.min(w - 1, x + 1)] !== i || label[Math.min(h - 1, y + 1) * w + x] !== i || label[y * w + Math.max(0, x - 1)] !== i || label[Math.max(0, y - 1) * w + x] !== i;
      const k = edge ? 1.25 : 1;
      o[di] = Math.min(255, d[si] * k + (edge ? 18 : 0)); o[di + 1] = Math.min(255, d[si + 1] * k + (edge ? 16 : 0)); o[di + 2] = Math.min(255, d[si + 2] * k + (edge ? 10 : 0));
      o[di + 3] = d[si + 3];
      po[di] = d[si]; po[di + 1] = d[si + 1]; po[di + 2] = d[si + 2]; po[di + 3] = d[si + 3];
    }
    cg.putImageData(id, 0, 0);
    pg.putImageData(pd, 0, 0);
    const nx = p[0] / w, ny = p[1] / h;
    shards.push({
      cv, plain, x: x0, y: y0, w: bw, h: bh, cx: p[0], cy: p[1], nx, ny,
      tb: 0.1 + (1 - nx) * 0.52 + ny * 0.05 + r() * 0.07, // 右侧先碎
      kx: 60 + r() * 150, ky: -30 - r() * 80, rot: (r() - 0.5) * 7,
      px: 760 + (r() - 0.5) * 280, py: 822 + (r() - 0.5) * 36 - Math.abs(r() - 0.5) * 30,
      dots: Array.from({ length: 3 }, () => [(r() - 0.5) * 16, (r() - 0.5) * 16, 0.7 + r() * 1.4]),
    });
  });
}
// 第 6、7 幕里瓶体在设计坐标中的位置
function vasePose() {
  // 窑中瓶（图 6 中约 1142,479，高 162）→ 画面中央成品（823,486，高 640）→ 右侧准备破碎
  const a = smooth(0.662, 0.705, P);
  const m = smooth(0.775, 0.815, P);
  const cx0 = lerp(1142, 823, a), cy0 = lerp(479, 486, a), h0 = lerp(162, 640, a);
  return { cx: lerp(cx0, 1090, m), cy: lerp(cy0, 384, m), h: lerp(h0, 380, m), r: lerp(0, -12, m) };
}

function update() {
  textRoot.querySelectorAll('.ch-block').forEach((b) => { b.style.opacity = 0; });
  // 主体进出场的节奏（各幕通用）：上一幕主体离开后，下一幕主体才出现，不会叠成“剪影”
  const subIn = (t) => smooth(0.2, 0.36, t);
  const subOut = (t) => smooth(0.72, 0.95, t);
  const subFade = (t) => 1 - smooth(0.74, 0.88, t);
  // 壹 择土
  {
    const A = acts.soil, t = local(0, 0.14);
    on(A.c, P < 0.17);
    if (P < 0.17) {
      const k = cam(t), ex = subOut(t);
      style(A.bg, { s: k.s, o: t < 0.5 ? smooth(0, 0.12, t) * (1 - k.ex) : k.o, blur: t < 0.5 ? 0 : k.blur });
      const form = smooth(0.12, 0.32, t);
      style(A.full, { s: k.s, o: smooth(0.3, 0.36, t) * (1 - smooth(0.68, 0.72, t)), blur: 0 });
      style(A.heap, { s: lerp(0.75, 1, form) * lerp(1, 2, ex), x: -ex * 720, y: -ex * 80, o: form * subFade(t), blur: ex * 4, origin: '50% 70%' });
      textStyle(A.text, t, 1, 1);
    }
  }
  // 贰 练泥
  {
    const A = acts.clay, t = local(0.14, 0.26);
    on(A.c, P > 0.1 && P < 0.29);
    if (P > 0.1 && P < 0.29) {
      const k = cam(t), ci = subIn(t), ex = subOut(t);
      style(A.bg, { s: k.s, o: k.o, blur: k.blur });
      style(A.full, { s: k.s, o: smooth(0.4, 0.45, t) * (1 - smooth(0.68, 0.72, t)), blur: 0 });
      const knead = Math.sin(t * Math.PI * 6) * (1 - ex) * smooth(0.45, 0.55, t) * (1 - smooth(0.66, 0.7, t));
      const sc = lerp(0.6, 1, ci) * lerp(1, 2, ex);
      style(A.clay, { sx: sc * (1 + knead * 0.022), sy: sc * (1 - knead * 0.022), r: Math.sin(t * Math.PI * 4) * 2 * smooth(0.45, 0.55, t), x: ex * 720, y: ex * -50, o: ci * subFade(t), blur: (1 - ci) * 2 + ex * 4 });
      textStyle(A.text, t, -1, -1);
    }
  }
  // 叁 成形：素坯展示后，缩向远处偏右，成为下一幕待施釉的瓶（同一件器物）
  {
    const A = acts.form, t = local(0.26, 0.38);
    on(A.c, P > 0.22 && P < 0.41);
    if (P > 0.22 && P < 0.41) {
      const k = cam(t), ci = subIn(t);
      const m = smooth(0.6, 0.86, t); // 移向第 4 幕远景瓶的位置，到位后再“施釉”交叉淡化
      style(A.bg, { s: k.s, o: k.o, blur: k.blur });
      style(A.full, { s: k.s, o: smooth(0.4, 0.45, t) * (1 - smooth(0.55, 0.6, t)), blur: 0 }); // 素坯开始移动前先换成去主体底图
      const turn = t * 2.2;
      const sc = lerp(0.6, 1, ci) * lerp(1, 300 / 505, m);
      style(A.vase, { sx: sc * (1 - 0.025 * Math.sin(turn * Math.PI) * (1 - m)), sy: sc, x: (1140 - 567.5) * m, y: (430 - 477.5) * m, o: ci * (1 - smooth(0.388, 0.405, P)), blur: (1 - ci) * 2 });
      const band = ((turn % 1) * 160 - 30).toFixed(1);
      A.shine.style.background = `linear-gradient(100deg, transparent ${+band - 22}%, rgba(255,240,215,.32) ${band}%, transparent ${+band + 22}%)`;
      A.shine.style.opacity = (1 - m).toFixed(3);
      textStyle(A.text, t, 1, 1);
    }
  }
  // 肆 施釉：远景瓶 → 同一镜头推近到瓶身特写。两层共用一个“相机”，瓶的位置和大小在推近过程中始终对齐
  {
    const A = acts.glaze, t = local(0.38, 0.55);
    on(A.c, P > 0.34 && P < 0.58);
    if (P > 0.34 && P < 0.58) {
      const en = smooth(0, 0.14, t), ex = smooth(0.8, 0.95, t);
      const Z = 5.2, Ax = 1140, Ay = 470, Bx = 1285, By = 660; // 图 4 瓶腹中心 ↔ 图 5 瓶腹中心，倍率 Z
      const pz = smooth(0.3, 0.56, t);
      const z = lerp(1, Z, pz * pz);
      const dk = (z - 1) / (Z - 1), dx = (Bx - Ax) * dk, dy = (By - Ay) * dk;
      // 近景只在推近的最后一段交叉淡入，并略放大以始终铺满画面（不露边、无需遮罩）
      const ns = z / Z;
      const nearO = smooth(0.86, 0.985, ns);
      const nsc = ns * lerp(1.12, 1, smooth(0.86, 1, ns));
      style(A.far, { x: dx, y: dy, s: lerp(0.82, 1, en) * z, o: en * (ns < 0.995 ? 1 : 0), blur: (1 - en) * 2.5, origin: `${Ax}px ${Ay}px` });
      style(A.farVase, { s: 1, o: smooth(0.386, 0.403, P) });
      style(A.farFull, { o: smooth(0.404, 0.412, P) });
      style(A.near, { x: Ax + dx - Bx + ex * 1100, y: Ay + dy - By, s: nsc * lerp(1, 1.35, ex), o: nearO * (1 - smooth(0.75, 1, ex)), blur: ex * 2.5, origin: `${Bx}px ${By}px` });
      const mask = ex > 0.001 ? `linear-gradient(to right, transparent ${(ex * 28).toFixed(1)}%, #000 ${(ex * 28 + 22).toFixed(1)}%)` : 'none';
      A.near.style.webkitMaskImage = A.near.style.maskImage = mask;
      A.svg.querySelectorAll('.note').forEach((g, i) => {
        const k = smooth(0.58 + i * 0.07, 0.66 + i * 0.07, t) * (1 - smooth(0.82, 0.9, t));
        g.querySelector('path').style.strokeDashoffset = (1 - k).toFixed(3);
        g.style.opacity = k > 0.01 ? 1 : 0;
        A.noteEls[i].style.opacity = smooth(0.62 + i * 0.07, 0.68 + i * 0.07, t) * (1 - smooth(0.82, 0.9, t));
      });
      const tt = clamp((t - 0.4) / 0.6);
      textStyle(A.text, tt, -1, -1);
    }
  }
  // 伍 入窑
  {
    const A = acts.kiln, t = local(0.55, 0.68);
    on(A.c, P > 0.51 && P < 0.71);
    if (P > 0.51 && P < 0.71) {
      const k = cam(t);
      // 成品瓶从窑中原位升起的同一刻，底图换成去掉瓶的版本，避免出现两只瓶
      const lift = smooth(0.652, 0.662, P);
      style(A.bg, { s: k.s, o: k.o * (1 - lift), blur: k.blur, origin: '1140px 470px' });
      style(A.plate, { s: k.s, o: k.o * lift, blur: k.blur, origin: '1140px 470px' });
      const heat = smooth(0.2, 0.7, t) * (1 - k.ex);
      A.heat.style.opacity = (heat * 0.9).toFixed(3);
      A.heat.style.transform = `scale(${0.8 + heat * 0.4})`;
      A.rings.forEach((r, i) => {
        const d = smooth(0.12 + i * 0.1, 0.42 + i * 0.1, t);
        r.style.strokeDashoffset = (1 - d).toFixed(3);
        r.style.opacity = ((0.35 + heat * 0.65) * (1 - k.ex)).toFixed(3);
        r.style.transformOrigin = '1140px 470px';
        r.style.transform = `scale(${lerp(1, 1.6 + i * 0.3, k.ex)})`;
      });
      textStyle(A.text, t, -1, -1);
    }
  }
  // 陆 成器 + 柒 消解：窑中的瓶直接从原位升起、放大到画面中央，成为成品；之后移到右侧破碎
  {
    const A = acts.finish, vis = P > 0.645 && P < 0.955;
    on(A.c, vis);
    if (vis) {
      const en = smooth(0.665, 0.705, P), sink = smooth(0.9, 0.95, P);
      const pan = smooth(0.775, 0.815, P);
      style(A.bg, { s: lerp(0.9, 1, en) * (1 + 0.03 * pan), x: -pan * 60, y: -sink * 140, o: en * (1 - sink), blur: (1 - en) * 2 });
      style(A.bg2, { s: 1 + 0.03 * pan, x: -pan * 60, y: -sink * 140, o: smooth(0.79, 0.825, P) * (1 - sink) });
      const pose = vasePose();
      const showDom = P < 0.8 || !shardCanvas;
      style(A.vase, { x: pose.cx - 823, y: pose.cy - 486, s: pose.h / 640, r: pose.r, o: showDom ? smooth(0.652, 0.664, P) : 0, origin: '50% 50%' });
      const breathe = 0.85 + 0.15 * Math.sin(performance.now() / 900);
      A.glow.style.opacity = (en * (1 - smooth(0.78, 0.84, P)) * breathe).toFixed(3);
      A.glow.style.transform = `translate(${pose.cx - 823}px, ${pose.cy - 486}px) scale(${pose.h / 640})`;
      const grow = smooth(0.84, 0.93, P);
      style(A.pile, { sx: lerp(0.4, 1, grow), sy: lerp(0.15, 1, grow), y: -sink * 140, o: grow * (1 - sink), origin: '50% 85%' });
      const tk = smooth(0.7, 0.73, P) * (1 - smooth(0.84, 0.87, P));
      A.text.style.opacity = tk.toFixed(3);
    }
  }
  // 捌 承艺
  {
    const A = acts.legacy, vis = P > 0.9;
    on(A.c, vis);
    if (vis) {
      const t = clamp((P - 0.92) / 0.08), en = smooth(0.905, 0.94, P);
      style(A.bg, { s: lerp(1.08, 1, en), y: (1 - en) * 120, o: en });
      const g = smooth(0.08, 0.62, t);
      // 土堆由下往上堆高：用渐变遮罩，边缘柔和而非一刀切
      const top = ((1 - g) * 110 - 10).toFixed(1);
      A.heap.style.webkitMaskImage = A.heap.style.maskImage = `linear-gradient(to bottom, transparent ${top}%, #000 ${(+top + 14).toFixed(1)}%)`;
      style(A.heap, { sy: lerp(0.6, 1, g), o: g > 0.01 ? 1 : 0, origin: '50% 90%' });
      A.text.style.opacity = smooth(0.45, 0.6, t).toFixed(3);
      A.steps.forEach((s, i) => s.classList.toggle('on', t > 0.55 + i * 0.07));
    } else {
      A.text.style.opacity = 0;
      A.steps.forEach((s) => s.classList.remove('on'));
    }
    endEl.classList.toggle('on', P > 0.975);
  }

  order();
  // 顶部序号 / 品牌
  const ai = ACTS.findIndex((a) => P >= a.range[0] && P < a.range[1]);
  const cur = ai < 0 ? ACTS.length - 1 : ai;
  const act = ACTS[cur];
  if (act.side === 'top') app.setBrand('', false); else app.setBrand(act.num, true);
  indexEl.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === cur));
}
function on(c, v) { c.classList.toggle('on', v); }
// 叠放顺序：正在离场的一幕在上层，镜头“穿过”它；正在进场的一幕在下层
function order() {
  const list = [
    [acts.soil.c, 0.07], [acts.clay.c, 0.2], [acts.form.c, 0.32], [acts.glaze.c, 0.465],
    // 入窑 → 成器例外：成品瓶在进场的一幕里，从窑中原位升起，所以成器一幕始终在入窑之上
    [acts.kiln.c, 2], [acts.finish.c, 0.8], [acts.legacy.c, 2],
  ];
  for (const [c, mid] of list) c.style.zIndex = P > mid ? 2 : 1;
}

function drawFx(now, dt) {
  fitCanvas(fx);
  const dpr = fx.width / fx.clientWidth;
  const W = fx.width, H = fx.height;
  fctx.setTransform(1, 0, 0, 1, 0, 0);
  fctx.clearRect(0, 0, W, H);
  const reduced = app.reduced;
  const t = now / 1000;
  const toS = (x, y) => [(stageT.x + x * stageT.s) * dpr, (stageT.y + y * stageT.s) * dpr];
  const sc = stageT.s * dpr;

  // 穿行的薄雾与近景粒子：随滚动从中心向四周掠过镜头
  fctx.globalCompositeOperation = 'lighter';
  const fogN = reduced ? 0 : 7;
  for (let i = 0; i < fogN; i++) {
    const z = (i / fogN + P * 5 + t * 0.004) % 1;
    const ang = i * 2.399;
    const R = lerp(0.25, 1.9, z * z) * W * 0.32;
    const x = W / 2 + Math.cos(ang) * z * z * W * 0.55, y = H / 2 + Math.sin(ang) * z * z * H * 0.5;
    fctx.globalAlpha = Math.sin(Math.PI * z) * 0.07;
    fctx.drawImage(fogSp, x - R, y - R * 0.7, R * 2, R * 1.4);
  }
  const moteN = reduced ? 0 : 34;
  for (let i = 0; i < moteN; i++) {
    const z = (i / moteN + P * 9 + t * 0.01) % 1;
    const ang = i * 2.399 + 0.6;
    const x = W / 2 + Math.cos(ang) * (0.08 + z * z) * W * 0.6 - mouse.sx * z * z * 40 * dpr, y = H / 2 + Math.sin(ang) * (0.08 + z * z) * H * 0.62 - mouse.sy * z * z * 26 * dpr;
    const r = (1 + z * z * 16) * dpr;
    fctx.globalAlpha = Math.sin(Math.PI * z) * (z > 0.8 ? 0.22 : 0.5);
    fctx.drawImage(gold, x - r, y - r, r * 2, r * 2);
  }

  // 壹：土粒聚堆
  if (P < 0.17 && gather.length) {
    const tl = local(0, 0.14);
    const k = smooth(0.02, 0.3, tl), fade = 1 - smooth(0.24, 0.34, tl);
    if (fade > 0) {
      for (const p of gather) {
        const e = smooth(p.d * 0.6, 0.6 + p.d, k);
        const x = lerp(p.sx, p.tx, e), y = lerp(p.sy, p.ty, e);
        const [sx, sy] = toS(x, y);
        const r = p.sz * (1 + (1 - e) * 3) * sc;
        fctx.globalAlpha = fade * (0.25 + e * 0.6);
        fctx.drawImage(clayDot, sx - r * 2, sy - r * 2, r * 4, r * 4);
      }
    }
  }

  // 陆：金色细点在不同深度从上向下缓落
  if (P > 0.66 && P < 0.82) {
    const a = smooth(0.66, 0.7, P) * (1 - smooth(0.79, 0.82, P));
    const r0 = rng(77);
    for (let i = 0; i < 60; i++) {
      const x0 = 380 + r0() * 900, sp = 18 + r0() * 40, z = r0();
      const y = ((t * sp + r0() * SH + P * 1200 * z) % (SH + 60)) - 30;
      const [sx, sy] = toS(x0 + Math.sin(t * 0.6 + i) * 10, y);
      const r = (0.8 + z * 2.4) * sc;
      fctx.globalAlpha = a * (0.35 + 0.5 * (0.5 + 0.5 * Math.sin(t * 2 + i)));
      fctx.drawImage(gold, sx - r * 2, sy - r * 2, r * 4, r * 4);
    }
  }

  // 柒：从右向左破碎，碎片先向右散开，再沿弧线落向下方，细化为泥
  if (P >= 0.8 && P < 0.955 && shardCanvas) {
    const tl = clamp((P - 0.8) / 0.12);
    const sink = smooth(0.9, 0.95, P);
    const pose = vasePose();
    const scale = pose.h / VASE_H;
    const cosr = Math.cos(pose.r * Math.PI / 180), sinr = Math.sin(pose.r * Math.PI / 180);
    const w = shardCanvas.width, h = shardCanvas.height;
    fctx.globalCompositeOperation = 'source-over';
    for (const s of shards) {
      const a = clamp((tl - s.tb) / 0.34);
      // 原位：碎片中心（瓶体局部坐标 → 设计坐标）
      const lx = (s.cx - w / 2) * scale, ly = (s.cy - h / 2) * scale;
      const ox = pose.cx + lx * cosr - ly * sinr;
      const oy = pose.cy + lx * sinr + ly * cosr;
      let x = ox, y = oy, rot = pose.r * Math.PI / 180, size = 1;
      if (a > 0) {
        const e = Math.pow(a, 1.25);
        const cx = ox + s.kx * 1.4, cy = oy + s.ky;
        x = (1 - e) * (1 - e) * ox + 2 * (1 - e) * e * cx + e * e * s.px;
        y = (1 - e) * (1 - e) * oy + 2 * (1 - e) * e * cy + e * e * s.py;
        rot += s.rot * a;
        size = 1 - 0.7 * a;
      }
      y -= sink * 140;
      const [sx, sy] = toS(x, y);
      // 瓷片在飞行中细化、淡去，换成泥粒
      const imgA = 1 - smooth(0.25, 0.6, a);
      if (imgA > 0.01) {
        const k = size * scale * sc;
        fctx.globalAlpha = imgA * (1 - sink);
        fctx.setTransform(Math.cos(rot) * k, Math.sin(rot) * k, -Math.sin(rot) * k, Math.cos(rot) * k, sx, sy);
        // 裂纹先于剥落出现：裂纹前沿到达之前，碎片是完整瓶面（无亮边）
        fctx.drawImage(s.plain, s.x - s.cx, s.y - s.cy);
        const crack = smooth(s.tb - 0.07, s.tb - 0.005, tl);
        if (crack > 0.01) { fctx.globalAlpha = imgA * (1 - sink) * crack; fctx.drawImage(s.cv, s.x - s.cx, s.y - s.cy); }
        fctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      if (a > 0.15) {
        const da = smooth(0.15, 0.45, a) * (1 - smooth(0.9, 1, a)) * (1 - sink);
        fctx.globalAlpha = da * 0.9;
        for (const [dx, dy, dz] of s.dots) {
          const spread = 1 + a * 1.5, rr = dz * 1.8 * sc;
          fctx.drawImage(clayDot, sx + dx * spread * sc - rr, sy + dy * spread * sc - rr, rr * 2, rr * 2);
        }
      }
      // 破裂前沿的金色亮点
      if (Math.abs(tl - s.tb) < 0.025) {
        const rr = 3.5 * sc;
        fctx.globalCompositeOperation = 'lighter';
        fctx.globalAlpha = (1 - Math.abs(tl - s.tb) / 0.025) * 0.8;
        fctx.drawImage(gold, sx - rr * 2, sy - rr * 2, rr * 4, rr * 4);
        fctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  // 捌：泥土从顶光中连续落到台面
  if (P > 0.915) {
    const tl = clamp((P - 0.92) / 0.08);
    const r0 = rng(31);
    fctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 220; i++) {
      const ts = r0() * 0.56, dur = 0.08 + r0() * 0.06, x0 = 836 + (r0() - 0.5) * 240, land = 560 + r0() * 70;
      const k = (tl - ts) / dur;
      if (k < 0 || k > 1.15) continue;
      const e = Math.min(1, k) ** 2;
      const [sx, sy] = toS(x0 + (r0() - 0.5) * 40 * e, lerp(-20, land, e));
      const r = (0.8 + r0() * 1.6) * sc;
      fctx.globalAlpha = (k > 1 ? 1 - (k - 1) / 0.15 : 0.9) * 0.8;
      fctx.drawImage(clayDot, sx - r * 2, sy - r * 2, r * 4, r * 4);
    }
  }

  // 引导光点与渐隐尾迹
  fctx.globalCompositeOperation = 'lighter';
  const [lx, ly] = keyPath(LIGHT, P);
  const drift = reduced ? [0, 0] : [Math.sin(t * 0.9) * 6, Math.cos(t * 0.7) * 5];
  const [px, py] = toS(lx + drift[0], ly + drift[1]);
  trail.push([px, py, now]);
  trail = trail.filter((p) => now - p[2] < 650).slice(-60);
  for (let i = 1; i < trail.length; i++) {
    const age = (now - trail[i][2]) / 650;
    fctx.globalAlpha = (1 - age) * 0.5;
    fctx.strokeStyle = 'rgba(255,220,160,1)';
    fctx.lineWidth = (1 - age) * 2.2 * dpr;
    fctx.beginPath();
    fctx.moveTo(trail[i - 1][0], trail[i - 1][1]);
    fctx.lineTo(trail[i][0], trail[i][1]);
    fctx.stroke();
  }
  const behind = P > 0.57 && P < 0.6 ? 0.35 : 1; // 穿过窑中瓶后时被遮挡
  const pulse = 0.8 + 0.2 * Math.sin(t * 2.4);
  const R = 26 * dpr * pulse;
  fctx.globalAlpha = 0.5 * behind;
  fctx.drawImage(gold, px - R, py - R, R * 2, R * 2);
  fctx.globalAlpha = 0.95 * behind;
  const r = 6 * dpr;
  fctx.drawImage(gold, px - r, py - r, r * 2, r * 2);
  fctx.globalAlpha = 1;
  fctx.globalCompositeOperation = 'source-over';
}

function layout() {
  const vw = innerWidth, vh = innerHeight;
  let fxv = 0.5;
  if (vw / vh < 1.45) {
    for (let i = 0; i < FOCUS.length; i++) if (P >= FOCUS[i][0]) fxv = FOCUS[i][1];
    fxv = lerp(0.5, fxv, clamp((1.45 - vw / vh) / 0.6));
  }
  stageT = cover(vw, vh, SW, SH, fxv, 0.5);
  // 画面略放大 2%，留出鼠标视差的余量，边缘不露底
  const ps = 1.02, px = mouse.sx * -14, py = mouse.sy * -9;
  stageT = { s: stageT.s * ps, x: stageT.x - (SW * stageT.s * (ps - 1)) / 2 + px, y: stageT.y - (SH * stageT.s * (ps - 1)) / 2 + py };
  stage.style.transform = `translate(${stageT.x}px, ${stageT.y}px) scale(${stageT.s})`;
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now;
  const k = app.reduced ? 1 : 1 - Math.exp(-dt * 6);
  P += (Pt - P) * k;
  const mk = app.reduced ? 0 : 1 - Math.exp(-dt * 3);
  mouse.sx += ((app.reduced ? 0 : mouse.x) - mouse.sx) * (app.reduced ? 1 : mk);
  mouse.sy += ((app.reduced ? 0 : mouse.y) - mouse.sy) * (app.reduced ? 1 : mk);
  if (Math.abs(Pt - P) < 1e-5) P = Pt;
  layout();
  update();
  updateVideos();
  drawFx(now, dt);
}

function nudge(d) {
  Pt = clamp(Pt + d);
  if (!touched && d > 0) { touched = true; hint.classList.add('off'); }
}

export const chapter = {
  init(a) {
    app = a;
    root = $('#scene-chapter');
    stage = $('#ch-stage');
    fx = $('#ch-fx');
    fctx = fx.getContext('2d');
    textRoot = $('#ch-text');
    indexEl = $('#ch-index');
    hint = $('#ch-hint');
    endEl = $('#ch-end');
    build();
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
      nudge(clamp(d, -240, 240) / SCROLL_LEN);
    }, { passive: false });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      mouse.x = (e.clientX / innerWidth - 0.5) * 2;
      mouse.y = (e.clientY / innerHeight - 0.5) * 2;
    });
    let ty = null;
    root.addEventListener('touchstart', (e) => { ty = e.touches[0].clientY; }, { passive: true });
    root.addEventListener('touchmove', (e) => {
      if (ty === null) return;
      const y = e.touches[0].clientY;
      nudge(((ty - y) * 3.2) / SCROLL_LEN);
      ty = y;
    }, { passive: true });
    root.addEventListener('touchend', () => { ty = null; });
    window.addEventListener('keydown', (e) => {
      if (app.scene !== 'chapter') return;
      if (['ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); nudge(e.key === 'ArrowDown' ? 0.012 : 0.04); }
      if (['ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); nudge(e.key === 'ArrowUp' ? -0.012 : -0.04); }
      if (e.key === 'End') nudge(1);
      if (e.key === 'Home') nudge(-1);
      if (e.key === 'Escape') app.go('object');
    });
    $('#btn-to-workbench').addEventListener('click', () => app.go('workbench'));
    $('#btn-replay-chapter').addEventListener('click', () => { Pt = 0; });
  },
  async enter(opts = {}) {
    app.setBack('返回器物', () => app.go('object'));
    app.setSkip('跳过，直接创作', () => app.go('workbench'));
    if (!opts.keep) { P = Pt = 0; touched = false; hint.classList.remove('off'); trail = []; }
    running = true;
    loadAssets();
    last = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  },
  leave() {
    running = false;
    app.setBrand('承艺', true);
    setTimeout(() => { if (!running) cancelAnimationFrame(raf); }, 900);
  },
  /** 在器物近景时提前加载篇章素材，进入时不必等待。 */
  preload() { return loadAssets(); },
  // 调试 / 截图用：直接跳到某个进度
  seek(p) { P = Pt = clamp(p); },
};
