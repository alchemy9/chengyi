// 器物近景：中央只有一件实体器物；左右两件为金色粒子轮廓，可点选切换。
// 切换时旧实体失去质感、散为粒子退到侧边，目标粒子聚合到中央再显出实体，镜头随之横移推进。
import { $, $$, clamp, cover, lerp, smooth, easeInOut, glowSprite, loadImage, rng, tween } from './util.js';
import { OBJECTS, CLOSEUP_SIZE } from './data.js';

const SW = CLOSEUP_SIZE.w, SH = CLOSEUP_SIZE.h;
// 槽位：-2 / 2 为画面外（进出场），-1 左，0 中，1 右
const SLOT = {
  '-2': { x: -220, y: 430, k: 0.75, a: 0 },
  '-1': { x: 355, y: 428, k: 1, a: 1 },
  '0': { x: 837, y: 470, k: 1, a: 1 },
  '1': { x: 1340, y: 466, k: 1, a: 1 },
  '2': { x: 1900, y: 460, k: 0.75, a: 0 },
};

let app, stage, canvas, ctx, solidsEl, layers;
let center = OBJECTS.findIndex((o) => o.id === 'celadon');
let state = {}; // id -> {x,y,h,solid,alpha,disp}
let switching = false, pending = 0, raf = 0, running = false, flyer = null;
let camera = { dx: 0, s: 1 };
let stageT = { s: 1, x: 0, y: 0 };
const sprite = glowSprite('255,214,150');
const N = OBJECTS.length;
const at = (i) => OBJECTS[((i % N) + N) % N];

/** 从透明图采样粒子：轮廓处更密，内部按亮度稀疏分布，使侧边粒子形体可辨认。 */
async function sampleParticles(o) {
  const img = await loadImage(o.particle);
  const maxD = 240;
  const sc = maxD / Math.max(img.width, img.height);
  const w = Math.max(8, Math.round(img.width * sc)), h = Math.max(8, Math.round(img.height * sc));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[(y * w + x) * 4 + 3]);
  const cand = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, a = d[i + 3];
    if (a < 50) continue;
    const lum = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
    const edge = Math.abs(A(x + 2, y) - A(x - 2, y)) + Math.abs(A(x, y + 2) - A(x, y - 2));
    const wgt = (edge > 120 ? 1 : 0.16 + lum * 0.3) * (a / 255);
    cand.push([x, y, wgt, d[i], d[i + 1], d[i + 2]]);
  }
  const r = rng(o.id.length * 97 + 3);
  const count = o.id === 'celadon' ? 1500 : 1100;
  const pts = [];
  let guard = 0;
  while (pts.length < count && cand.length && guard++ < count * 40) {
    const p = cand[(r() * cand.length) | 0];
    if (r() < p[2]) {
      const ang = r() * Math.PI * 2;
      pts.push({
        u: (p[0] + r() - 0.5 - w / 2) / h, v: (p[1] + r() - 0.5 - h / 2) / h,
        sz: 0.5 + r() * r() * 2.2, ph: r() * 6.28, sp: 0.6 + r() * 2,
        dx: Math.cos(ang) * (0.3 + r()), dy: Math.sin(ang) * (0.3 + r()) - 0.2,
      });
    }
  }
  o._pts = pts;
  o._aspect = img.width / img.height;
}

function slotState(k, o) {
  const s = SLOT[String(clamp(k, -2, 2))];
  const h = (k === 0 ? o.centerH : o.sideH) * s.k;
  return { x: s.x, y: s.y, h, solid: k === 0 ? 1 : 0, alpha: s.a, disp: 0 };
}

function layout() {
  const vw = innerWidth, vh = innerHeight;
  stageT = cover(vw, vh, SW, SH);
  stage.style.transform = `translate(${stageT.x}px, ${stageT.y}px) scale(${stageT.s})`;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const cw = Math.round(SW * stageT.s * dpr), ch = Math.round(SH * stageT.s * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  // 左右可点区域（比粒子本身大）
  const place = (btn, k) => {
    const o = at(center + k), s = SLOT[k];
    const size = Math.max(o.sideH * 1.25, 260) * stageT.s;
    const cx = stageT.x + s.x * stageT.s, cy = stageT.y + s.y * stageT.s;
    btn.style.width = btn.style.height = size + 'px';
    btn.style.left = clamp(cx - size / 2, -size * 0.3, vw - size * 0.7) + 'px';
    btn.style.top = cy - size / 2 + 'px';
    btn.querySelector('.co-hit-label').textContent = o.label;
    btn.setAttribute('aria-label', '切换到' + o.label);
  };
  place($('#co-hit-left'), -1);
  place($('#co-hit-right'), 1);
}

function resetStates() {
  for (let k = -2; k <= 2; k++) {
    const o = at(center + k);
    state[o.id] = slotState(k, o);
  }
}

function buildSolids() {
  solidsEl.innerHTML = '';
  for (const o of OBJECTS) {
    const ghost = document.createElement('div');
    ghost.className = 'co-solid co-ghost';
    ghost.dataset.id = o.id;
    if (o.overlay) ghost.innerHTML = `<img src="${o.overlay}" alt="">`;
    const d = document.createElement('div');
    d.className = 'co-solid';
    d.dataset.id = o.id;
    d.innerHTML = `<img src="${o.solid}" alt="${o.label}">` + (o.overlay ? `<img class="ov" src="${o.overlay}" alt="">` : '');
    o._el = d;
    o._ghost = o.overlay ? ghost : null;
    if (o.overlay) solidsEl.appendChild(ghost);
    solidsEl.appendChild(d);
  }
}

function render(now) {
  raf = requestAnimationFrame(render);
  const t = now / 1000;
  const dpr = canvas.width / (SW * stageT.s);
  ctx.setTransform(stageT.s * dpr, 0, 0, stageT.s * dpr, 0, 0);
  ctx.clearRect(0, 0, SW, SH);
  ctx.globalCompositeOperation = 'lighter';
  const reduced = app.reduced;

  // 景深层：镜头横移时近处移动更多
  layers.forEach((l) => {
    const dep = +l.dataset.depth;
    const idle = reduced ? 0 : Math.sin(t * 0.12 + dep) * 6 * dep;
    l.style.transform = `translate3d(${camera.dx * dep + idle}px, 0, 0) scale(${1 + (camera.s - 1) * dep})`;
  });

  for (const o of OBJECTS) {
    const st = state[o.id];
    const el = o._el;
    if (!st || (st.alpha <= 0.001 && st.solid <= 0.001)) { if (el) el.style.opacity = 0; if (o._ghost) o._ghost.style.opacity = 0; continue; }
    const asp = o._aspect || 1;
    const cx = st.x + camera.dx * 0.8, cy = st.y;
    // 实体
    if (el) {
      const h = st.h, w = h * asp;
      el.style.width = w + 'px'; el.style.height = h + 'px';
      el.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px)`;
      el.style.opacity = st.solid;
      const soft = 1 - st.solid;
      el.style.filter = soft > 0.01 ? `blur(${soft * 7}px) brightness(${1 + soft * 0.9}) saturate(${1 - soft * 0.6})` : 'none';
    }
    if (o._ghost) {
      const h = st.h * 1.05, w = h * asp;
      o._ghost.style.width = w + 'px'; o._ghost.style.height = h + 'px';
      o._ghost.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px)`;
      o._ghost.style.opacity = st.alpha * (1 - st.solid) * (1 - st.disp) * 0.55;
    }
    // 粒子
    const pts = o._pts;
    if (!pts) continue;
    const base = st.alpha * (1 - st.solid * 0.92);
    if (base < 0.01) continue;
    const scatter = st.disp * 160;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const sh = reduced ? 0 : Math.sin(t * p.sp + p.ph) * 1.4;
      const x = cx + p.u * st.h + p.dx * scatter + sh;
      const y = cy + p.v * st.h + p.dy * scatter + (reduced ? 0 : Math.cos(t * p.sp * 0.8 + p.ph) * 1.2);
      const tw = reduced ? 0.8 : 0.45 + 0.55 * Math.sin(t * p.sp * 1.7 + p.ph * 3);
      const r = p.sz * (1.6 + st.disp * 1.2);
      ctx.globalAlpha = base * tw * 0.85;
      ctx.drawImage(sprite, x - r * 2, y - r * 2, r * 4, r * 4);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function updateInfo() {
  const o = at(center);
  $('#co-name').textContent = o.label;
  $('#co-meta').textContent = o.statusText;
  const b = $('#btn-create');
  if (o.status === 'open') { b.disabled = false; b.innerHTML = '与 AI 开始创作 <span aria-hidden="true">›</span>'; }
  else { b.disabled = true; b.textContent = '即将开放'; }
  layout();
}

async function step(dir) {
  if (switching) { pending = dir; return; }
  switching = true;
  const info = $('#co-info');
  info.classList.add('fade');
  const before = {};
  for (let k = -2; k <= 2; k++) before[at(center + k).id] = k;
  center += dir;
  const after = {};
  for (let k = -2; k <= 2; k++) after[at(center + k).id] = k;
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const plan = [...ids].map((id) => {
    const o = OBJECTS.find((x) => x.id === id);
    const k0 = before[id] ?? (after[id] > 0 ? 2 : -2);
    const k1 = after[id] ?? (k0 > 0 ? 2 : -2);
    return { o, k0, k1, a: slotState(k0, o), b: slotState(k1, o) };
  });
  const dur = app.reduced ? 380 : 1250;
  await tween(dur, (_, t) => {
    const e = easeInOut(t);
    const arc = Math.sin(Math.PI * t);
    for (const p of plan) {
      const st = state[p.o.id] || (state[p.o.id] = { ...p.a });
      st.x = lerp(p.a.x, p.b.x, e);
      st.y = lerp(p.a.y, p.b.y, e) - ((p.k0 === 0 || p.k1 === 0) ? arc * 36 : 0);
      st.h = lerp(p.a.h, p.b.h, e);
      st.alpha = lerp(p.a.alpha, p.b.alpha, smooth(0, 1, t));
      if (p.k1 === 0) { // 目标：粒子先松散再聚合，最后显出实体
        st.solid = smooth(0.62, 1, t);
        st.disp = app.reduced ? 0 : 0.45 * Math.sin(Math.PI * Math.min(1, t / 0.8));
      } else if (p.k0 === 0) { // 原中央：先失去质感，再散开，退到侧边重组
        st.solid = 1 - smooth(0, 0.32, t);
        st.disp = app.reduced ? 0 : 0.9 * Math.sin(Math.PI * t);
      } else {
        st.solid = 0;
        st.disp = app.reduced ? 0 : 0.15 * arc;
      }
    }
    camera.dx = app.reduced ? 0 : -dir * 70 * arc;
    camera.s = 1 + (app.reduced ? 0 : 0.035 * arc);
  }, (x) => x);
  camera.dx = 0; camera.s = 1;
  resetStates();
  updateInfo();
  info.classList.remove('fade');
  switching = false;
  if (pending) { const d = pending; pending = 0; step(d); }
}

/** 从地图飞入：器物从地图原位持续放大、移到中央，由发光轮廓显为实体。 */
async function flyIn(o, fromRect) {
  const st = state[o.id];
  const h = st.h * stageT.s, w = h * (o._aspect || 1);
  const tx = stageT.x + st.x * stageT.s - w / 2, ty = stageT.y + st.y * stageT.s - h / 2;
  st.solid = 0; st.alpha = 0;
  const f = document.createElement('img');
  f.src = o.solid;
  f.alt = '';
  f.style.cssText = `position:fixed;left:0;top:0;z-index:35;pointer-events:none;will-change:transform,filter;transform-origin:0 0;width:${w}px;height:${h}px`;
  document.body.appendChild(f);
  flyer = f;
  const fw = fromRect.width, fh = fromRect.height;
  // 地图小图含底部留白，按高度对齐
  const s0 = fh / h;
  const dur = app.reduced ? 300 : 1150;
  await tween(dur, (e, t) => {
    const s = lerp(s0, 1, e);
    const x = lerp(fromRect.left + (fw - w * s0) / 2, tx, e), y = lerp(fromRect.top, ty, e);
    const glow = Math.sin(Math.PI * t);
    f.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    f.style.filter = `brightness(${1 + glow * 0.5}) drop-shadow(0 0 ${12 + glow * 30}px rgba(244,220,170,${0.25 + glow * 0.35}))`;
  });
  st.solid = 1;
  await new Promise((r) => requestAnimationFrame(r));
  f.remove();
  flyer = null;
  // 两侧粒子随后显现
  const sides = [at(center - 1), at(center + 1)];
  await tween(app.reduced ? 200 : 700, (e) => { sides.forEach((s) => { state[s.id].alpha = e; }); });
}

export const closeup = {
  init(a) {
    app = a;
    stage = $('#co-stage');
    canvas = $('#co-particles');
    ctx = canvas.getContext('2d');
    solidsEl = $('#co-solids');
    layers = $$('.co-layer', stage);
    buildSolids();
    this.ready = Promise.all([
      ...OBJECTS.map(sampleParticles),
      ...OBJECTS.flatMap((o) => [o.solid, o.overlay].filter(Boolean).map((s) => loadImage(s).catch(() => null))),
    ]).catch(() => {});
    $('#co-hit-left').addEventListener('click', () => step(-1));
    $('#co-hit-right').addEventListener('click', () => step(1));
    $('#btn-create').addEventListener('click', () => {
      if (at(center).status !== 'open' || switching) return;
      app.go('chapter');
    });
    window.addEventListener('resize', () => app.scene === 'object' && layout());
    window.addEventListener('keydown', (e) => {
      if (app.scene !== 'object') return;
      if (e.key === 'Escape') back();
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    });
  },
  async enter(opts = {}) {
    app.setBrand('承艺');
    app.setBack('返回山河', back);
    if (opts.id) center = Math.max(0, OBJECTS.findIndex((o) => o.id === opts.id));
    app.modules.chapter?.preload?.();
    running = true;
    await this.ready;
    layout();
    resetStates();
    updateInfo();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
    if (opts.fromRect) {
      [at(center - 1), at(center + 1)].forEach((s) => { state[s.id].alpha = 0; });
      await flyIn(at(center), opts.fromRect);
    }
  },
  leave() {
    running = false;
    flyer?.remove();
    setTimeout(() => { if (!running) cancelAnimationFrame(raf); }, 900);
  },
  get current() { return at(center); },
};

function back() {
  if (switching) return;
  app.go('map', { back: true });
}
