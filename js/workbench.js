// 陶艺工作台：接续篇章最后一幕「承艺」。底图就是篇章的展台（assets/story/s9.jpg），
// 三维坯体按底图里青铜圆台的透视立在台面上；左侧五步与篇章结尾的流程线位置相同：择土 · 练泥 · 成形 · 施釉 · 入窑。
// 塑形内核与后端一致（js/pottery/），承艺 AI 见 js/agent.js。完成后入窑、落款，生成分享图。
import * as THREE from 'three';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { $, $$, clamp, cover, fitCanvas, glowSprite, loadImage, prefs, rng, tween, wait } from './util.js';
import * as G from './pottery/geometry.js';
import * as M from './pottery/model.js';
import { createSurface, patternThumb } from './pottery/surface.js';
import { agent } from './agent.js';

// ---------- 底图与相机对位 ----------
const DESIGN = { w: 1672, h: 941 };
const PLINTH = { x: 834, y: 658, a: 362, b: 39 }; // s9 中圆台顶面椭圆：中心与半轴（设计稿像素，扫描像素测得）
const R = 4.4; // 圆台半径，世界单位（1 = 6 厘米）
const FOV = 30;
const F = DESIGN.h / 2 / Math.tan((FOV / 2) * Math.PI / 180); // 设计稿像素焦距
const PHI = Math.asin(PLINTH.b / PLINTH.a); // 看台面的俯角
const DIST = (F * R) / PLINTH.a;
const pxPerUnit = F / DIST; // 台面中心处 1 单位对应的设计稿像素

const STEPS = [
  { id: 'soil', name: '择土', num: '壹', sub: '选一种泥' },
  { id: 'clay', name: '练泥', num: '贰', sub: '揉泥定坯' },
  { id: 'form', name: '成形', num: '叁', sub: '拉坯塑形' },
  { id: 'glaze', name: '施釉', num: '肆', sub: '着衣绘饰' },
  { id: 'kiln', name: '入窑', num: '伍', sub: '一窑天成' },
];
const TOOLS = [
  { id: 'hand', name: '手掌', note: '大范围推拉', w: 1 },
  { id: 'spatula', name: '刮刀', note: '收拢修弧线', w: 0.5 },
  { id: 'carve', name: '细针', note: '刻出旋纹', w: 0.11 },
  { id: 'smooth', name: '抚平', note: '柔化起伏', w: 0.8 },
];
const OUTLINES = ['circle', 'heart', 'flower', 'square', 'hexagon', 'triangle', 'oval', 'star', 'teardrop'];
const OUTLINE_AREAS = ['whole', 'mouth', 'upper', 'middle', 'lower'];

let app, wrap, renderer, scene, camera, pot, surface, brushRing, marker, contact, topRenderer, topCamera;
let doc, rows, step = 'soil', zoom = 1, view = null, bgImg = null;
let undoStack = [], redoStack = [], editStart = null, remoteHistory = null, saveTimer = 0;
let tool = 'hand', brush = 50, strength = 45, outlineArea = 'whole';
let raf = 0, running = false, firing = false, interaction = null, spin = 0, lastInput = 0, intro = null;
let topOpen = false, applyingRemote = false, handMarks = [];
const listeners = new Set();
let fx, fctx, motes = [], sprite;

// ---------- 场景 ----------
function setupScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  wrap.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;

  // 相机：与底图的透视一致。圆台中心在光轴下方 below 角
  camera = new THREE.PerspectiveCamera(FOV, DESIGN.w / DESIGN.h, 0.5, 80);
  const below = Math.atan((PLINTH.y - DESIGN.h / 2) / F);
  camera.position.set(((DESIGN.w / 2 - PLINTH.x) / F) * DIST, DIST * Math.sin(PHI), DIST * Math.cos(PHI));
  camera.rotation.set(-(PHI - below), 0, 0);

  // 光：顶上一束暖光（与底图光柱同向），背后一道轮廓光，前方弱补光
  scene.add(new THREE.HemisphereLight(0x8d9c9a, 0x1a120c, 0.45));
  const key = new THREE.SpotLight(0xffdcb0, 3.4, 0, 0.3, 0.75, 0);
  key.position.set(0.4, 17, 2.2);
  key.target.position.set(0, 2.2, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 6;
  key.shadow.camera.far = 26;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xffd2a0, 1.5);
  rim.position.set(-2, 9, -12);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xbfcfcb, 0.42);
  fill.position.set(-8, 4, 12);
  scene.add(fill);

  // 台面只接影子，本身透明：看到的仍是画中的青铜圆台
  const catcher = new THREE.Mesh(new THREE.CircleGeometry(R * 0.995, 96), new THREE.ShadowMaterial({ color: 0x140a04, opacity: 0.28 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = 0.002;
  catcher.receiveShadow = true;
  scene.add(catcher);
  // 器底接触阴影：光从正上方来时，器底仍需要一圈压暗才“落”在台上
  const cc = document.createElement('canvas');
  cc.width = cc.height = 128;
  const cg = cc.getContext('2d'), grd = cg.createRadialGradient(64, 64, 10, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.65)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.25)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  cg.fillStyle = grd; cg.fillRect(0, 0, 128, 128);
  contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cc), transparent: true, depthWrite: false }));
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.004;
  scene.add(contact);
  // 转盘记号：台沿一粒金点随转盘转动
  marker = new THREE.Group();
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), new THREE.MeshBasicMaterial({ color: 0xf4dcaa }));
  dot.position.set(0, 0.03, R * 0.9);
  marker.add(dot);
  scene.add(marker);

  surface = createSurface(THREE);
  pot = new THREE.Mesh(new THREE.BufferGeometry(), [surface.outer, surface.inner]);
  pot.castShadow = true;
  pot.receiveShadow = true;
  scene.add(pot);

  brushRing = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf4dcaa, transparent: true, opacity: 0.85 }));
  brushRing.visible = false;
  scene.add(brushRing);
  // 手势时两只手在画面里的位置：两粒金色光点，贴上坯体后变亮
  handMarks = [0, 1].map(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 16), new THREE.MeshBasicMaterial({ color: 0xf4dcaa, transparent: true, opacity: 0.45, depthTest: false }));
    m.renderOrder = 10;
    m.visible = false;
    scene.add(m);
    return m;
  });

  // 俯视小窗：第二个画布，正交相机从上往下看
  topRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  topRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  topRenderer.outputColorSpace = THREE.SRGBColorSpace;
  topRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  topRenderer.setClearColor(0x000000, 0);
  $('#wb-top-view').appendChild(topRenderer.domElement);
  topCamera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 60);
  topCamera.up.set(0, 0, -1);
}

/** 底图按 cover 铺满，再以器身中部为中心缩放；三维画面用 setViewOffset 渲染同一块区域，像素级对齐。 */
function layout() {
  const vw = wrap.clientWidth, vh = wrap.clientHeight;
  if (!vw || !vh) return;
  // 与篇章舞台一致：cover 铺满后再放大 2%，从篇章进入时展台不跳
  const base = cover(vw, vh, DESIGN.w, DESIGN.h), ps = 1.02;
  let S0 = base.s * ps, tx0 = base.x - (DESIGN.w * base.s * (ps - 1)) / 2, ty0 = base.y - (DESIGN.h * base.s * (ps - 1)) / 2;
  if (vw < 760 || vw / vh < 1) {
    // 竖屏：横幅底图铺满会把器物放得过大，改为让圆台占满屏宽，底图边缘淡入暗处
    S0 = Math.min(S0, (0.96 * vw) / (2 * PLINTH.a));
    tx0 = vw / 2 - PLINTH.x * S0;
    ty0 = vh * 0.47 - PLINTH.y * S0;
  }
  const cx = PLINTH.x, cy = PLINTH.y - (doc.height / 6) * pxPerUnit * 0.5; // 以器身中部为缩放中心
  const S = S0 * zoom;
  const tx = cx * S0 + tx0 - cx * S, ty = cy * S0 + ty0 - cy * S;
  view = { S, tx, ty, vw, vh };
  const bg = $('#wb-bg');
  bg.style.transform = `translate(${tx}px, ${ty}px) scale(${S})`;
  bg.classList.toggle('uncovered', tx > 0.5 || ty > 0.5 || tx + DESIGN.w * S < vw - 0.5 || ty + DESIGN.h * S < vh - 0.5);
  renderer.setSize(vw, vh, false);
  camera.setViewOffset(DESIGN.w * S, DESIGN.h * S, -tx, -ty, vw, vh);
}
const toScreen = (x, y) => [x * view.S + view.tx, y * view.S + view.ty];

// ---------- 文档 ----------
function rebuild() {
  rows = G.grid(doc);
  const old = pot.geometry;
  pot.geometry = G.buildGeometry(THREE, doc, rows);
  old.dispose();
  contact.scale.setScalar(Math.max(1.2, rows[0].reduce((a, b) => Math.max(a, b), 0) * 2.6));
  const meas = M.measure(doc, rows);
  $('#wb-measure').textContent = `高 ${meas.height.toFixed(1)} 厘米 · 最大径 ${meas.diameter.toFixed(1)} 厘米`;
}

function sync() {
  rebuild();
  surface.update(doc, rows);
  zoom = clamp(doc.view.zoom_percent / 100, 0.8, 1.9);
  setTopOpen(doc.view.direction === 'top', false);
  layout();
  updateTools();
  renderPanel();
}

function getDocument() {
  const pose = (((pot.rotation.y * 180) / Math.PI + 180) % 360 + 360) % 360 - 180;
  return { ...M.clone(doc), name: (doc.name || '').trim() || '未命名的器', wheel: { ...doc.wheel, rotation_deg: pose } };
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => prefs.set('pottery', getDocument()), 400);
}

function notify() {
  if (applyingRemote) return;
  const d = getDocument();
  doc.wheel.rotation_deg = d.wheel.rotation_deg;
  listeners.forEach((fn) => fn(d));
}

function beginEdit() { if (!editStart) editStart = M.clone(doc); }
function commitEdit() {
  let changed = false;
  if (editStart && JSON.stringify(editStart) !== JSON.stringify(doc)) {
    undoStack.push(editStart);
    if (undoStack.length > 40) undoStack.shift();
    redoStack = [];
    changed = true;
  }
  editStart = null;
  if (changed) { persist(); updateTools(); notify(); }
}
function record(fn) { beginEdit(); fn(); commitEdit(); }

/** 整份替换文档并记一步历史（面板操作、本机 AI、灵感）。 */
function commitDocument(next, calls = []) {
  record(() => { doc = next; sync(); });
  if (calls.some((c) => c.tool === 'set_cross_section' && c.arguments.shape)) app.toast('从上面看：已打开俯视小窗');
  jumpToStepFor(calls);
}
/** 按改动的内容切到对应步骤，让用户看到面板随之变化。 */
function jumpToStepFor(calls) {
  const tools = calls.map((c) => c.tool);
  const target = tools.includes('set_glaze') ? 'glaze'
    : tools.some((t) => ['set_cross_section', 'reshape_region', 'smooth_surface'].includes(t)) ? 'form'
    : tools.some((t) => ['set_base_shape', 'set_dimensions'].includes(t)) ? 'clay'
    : tools.includes('set_material') ? 'soil' : null;
  if (target && target !== step && !firing) setStep(target);
}

function change(mutator) {
  try {
    const next = M.clone(doc);
    mutator(next);
    commitDocument(M.validate(next));
  } catch (e) {
    app.toast(e.message || '超出了工作台能做的范围');
  }
}
function tools(calls) {
  try {
    const { doc: next } = M.applyLocal(doc, calls);
    commitDocument(next, calls);
  } catch (e) {
    app.toast('这样改会超出工作台能做的范围');
    renderPanel();
  }
}

function undo() {
  commitEdit();
  if (agent.online) { agent.command('撤销'); return; }
  if (!undoStack.length) return;
  redoStack.push(M.clone(doc));
  doc = undoStack.pop();
  sync(); persist(); notify();
  app.toast('已撤销');
}
function redo() {
  if (agent.online) { agent.command('重做'); return; }
  if (!redoStack.length) return;
  undoStack.push(M.clone(doc));
  doc = redoStack.pop();
  sync(); persist(); notify();
  app.toast('已恢复');
}

// ---------- 界面：步骤与面板 ----------
function renderSteps() {
  const idx = STEPS.findIndex((s) => s.id === step);
  $('#wb-steps').innerHTML = STEPS.map((s, i) => `<button class="wb-step${s.id === step ? ' on' : ''}${i < idx ? ' done' : ''}" data-step="${s.id}" aria-current="${s.id === step ? 'step' : 'false'}"><i></i><span>${s.name}</span></button>`).join('');
  $$('#wb-steps button').forEach((b) => b.addEventListener('click', () => setStep(b.dataset.step)));
}
function setStep(id) {
  if (firing) return;
  step = id;
  wrap.classList.toggle('sculpt', step === 'form');
  hint(step === 'form' ? '按住坯体左右拖动塑形 · 拖动空白处转动转盘 · 滚轮远近' : '拖动转动转盘 · 滚轮远近');
  renderSteps();
  renderPanel();
}
function hint(text) {
  const h = $('#wb-drag-hint');
  h.textContent = text;
  h.classList.remove('off');
  clearTimeout(h._t);
  h._t = setTimeout(() => h.classList.add('off'), 5200);
}

const sw = (rgb) => { const [r, g, b] = rgb; return `background:radial-gradient(circle at 35% 30%, rgb(${Math.min(255, r + 34)},${Math.min(255, g + 34)},${Math.min(255, b + 34)}), rgb(${r},${g},${b}) 55%, rgb(${r * 0.66 | 0},${g * 0.66 | 0},${b * 0.66 | 0}))`; };
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function formSvg(id) {
  const p = M.makeProfile(id), h = M.formHeight(id), max = 2.6, H = 44 * Math.min(1, h / 30);
  const pts = p.map((r, i) => [17 + (r / max) * 16, 48 - (i / 95) * H]);
  const right = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const left = pts.slice().reverse().map(([x, y]) => `${(34 - x).toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 34 50" aria-hidden="true"><polygon points="${right} ${left}" fill="rgba(214,180,122,.16)" stroke="currentColor" stroke-width="1"/></svg>`;
}
function outlineSvg(shape) {
  const r = G.sectionRadii({ ...G.defaults(), shape, aspect_ratio: ['oval', 'rectangle'].includes(shape) ? 1.5 : 1 });
  const pts = r.filter((_, i) => i % 2 === 0).map((v, k) => { const a = (k * 2 * Math.PI * 2) / G.SEGMENTS; return `${(20 + Math.sin(a) * v * 15).toFixed(1)},${(20 - Math.cos(a) * v * 15).toFixed(1)}`; }).join(' ');
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><polygon points="${pts}" fill="rgba(214,180,122,.14)" stroke="currentColor" stroke-width="1"/></svg>`;
}
const slider = (key, label, min, max, stepv, value, lo, hi) => `<label class="slider"><span class="slider-label">${label}<output>${value}</output></span><input type="range" min="${min}" max="${max}" step="${stepv}" value="${value}" data-r="${key}"><span class="slider-ends"><span>${lo}</span><span>${hi}</span></span></label>`;

function renderPanel() {
  const panel = $('#wb-panel');
  const s = STEPS.find((x) => x.id === step), idx = STEPS.indexOf(s), next = STEPS[idx + 1];
  const head = `<p class="wb-kicker">${s.num} · ${s.sub}</p><h3>${s.name}</h3>`;
  const nextBtn = next ? `<button class="pill-btn next" data-step-to="${next.id}">下一步：${next.name} <span aria-hidden="true">›</span></button>` : '';
  let body = '';
  if (step === 'soil') {
    body = `<p class="lede">不同的泥，烧出不同的胎色与手感。施釉之前，你看到的就是泥本来的颜色。</p>
      <div class="wb-cards">${M.CLAYS.map((c) => `<button class="wb-card" data-clay="${c.id}" aria-pressed="${doc.material === c.id}"><span class="sw" style="${sw(hexRgb(c.color))}"></span><span><b>${c.name}</b><small>${c.note}</small></span></button>`).join('')}</div>`;
  } else if (step === 'clay') {
    const m = M.measure(doc, rows);
    body = `<p class="lede">泥经反复揉练，排尽气泡才能上轮。先定一个坯形与大小，下一步再亲手拉坯。</p>
      <div class="wb-group"><div class="wb-group-title">坯形 <em>${M.byId(M.FORMS, doc.preset).name}</em></div>
      <div class="opt-grid cols-5">${M.FORMS.map((f) => `<button class="opt" data-form="${f.id}" aria-pressed="${doc.preset === f.id}" title="${f.note}">${formSvg(f.id)}<span>${f.name}</span></button>`).join('')}</div></div>
      <div class="wb-group">${slider('height', '高度（厘米）', 8, 40, 0.5, doc.height.toFixed(1), '8', '40')}
      ${slider('diameter', '最大径（厘米）', 6, 34, 0.5, m.diameter.toFixed(1), '6', '34')}</div>
      <button class="link-btn wb-reset" data-reset>重新揉泥：恢复所选坯形</button>`;
  } else if (step === 'form') {
    const band = outlineArea === 'whole' ? doc.cross_section : ([...doc.section_bands].reverse().find((b) => { const [a, z] = M.PARTS[outlineArea]; return b.start_height_ratio === a && b.end_height_ratio === z; }) || doc.cross_section);
    body = `<p class="lede">在坯体上按住、左右拖动：向外拉放，向内收拢。转盘转动时整圈一起变化。</p>
      <div class="wb-group"><div class="wb-group-title">手法</div>
      <button class="wb-gesture" data-gesture aria-pressed="${gesture.active}"><b>${gesture.active ? '手势塑形中 · 点此关闭' : '用手势塑形'}</b><small>${gesture.active ? '双手贴在坯体两侧：分开变宽，合拢变窄' : '打开摄像头，用双手隔空拉坯'}</small></button>
      <div class="opt-grid cols-4">${TOOLS.map((t, i) => `<button class="opt tool" data-tool="${t.id}" aria-pressed="${tool === t.id}" title="${t.note}（按 ${i + 1}）"><kbd>${i + 1}</kbd><span>${t.name}</span><small>${t.note}</small></button>`).join('')}</div>
      ${slider('brush', '作用范围', 10, 100, 1, brush, '小', '大')}${slider('strength', '力度', 10, 100, 1, strength, '轻', '重')}</div>
      <div class="wb-group"><div class="wb-group-title">俯视形状 <em>${G.NAMES[band.shape]}</em></div>
      <div class="seg" role="group" aria-label="部位">${OUTLINE_AREAS.map((a) => `<button data-area="${a}" aria-pressed="${outlineArea === a}">${M.PART_NAMES[a]}</button>`).join('')}</div>
      <div class="opt-grid cols-5 outlines">${OUTLINES.map((o) => `<button class="opt" data-outline="${o}" aria-pressed="${band.shape === o}" title="${G.NAMES[o]}">${outlineSvg(o)}<span>${G.NAMES[o].replace('形', '')}</span></button>`).join('')}</div>
      ${slider('roundness', '边角', 0, 100, 1, Math.round(band.roundness * 100), '尖', '圆')}${slider('aspect', '宽扁', 0.4, 2.5, 0.1, band.aspect_ratio.toFixed(1), '窄', '宽')}</div>
      <div class="wb-group"><div class="wb-group-title">转盘 <em>${doc.wheel.rotating ? Math.round(doc.wheel.speed_rpm) + ' 转/分' : '已停'}</em></div>
      ${slider('speed', '转速', 5, 60, 1, Math.round(doc.wheel.speed_rpm), '慢', '快')}</div>`;
  } else if (step === 'glaze') {
    const g = M.byId(M.GLAZES, doc.glaze);
    body = `<p class="lede">釉色要在窑火中才会真正显现，这里预览的是烧成后的样子。</p>
      <div class="wb-group"><div class="wb-group-title">釉色 <em>${g.name}</em></div>
      <div class="opt-grid cols-5 glazes">${M.GLAZES.map((o) => `<button class="opt" data-glaze="${o.id}" aria-pressed="${doc.glaze === o.id}" title="${o.note}"><span class="sw" style="${sw(o.rgb || hexRgb(M.clayOf(doc.material).color))}"></span><span>${o.name}</span></button>`).join('')}</div>
      ${slider('gloss', '光泽', 0, 100, 1, Math.round(doc.gloss), '哑光', '亮釉')}
      <div class="toggle-row"><button class="chip" data-crackle aria-pressed="${doc.crackle}" ${doc.glaze === 'none' ? 'disabled' : ''}>开片</button></div></div>
      <div class="wb-group"><div class="wb-group-title">纹样 <em>${M.byId(M.PATTERNS, doc.pattern).name}</em></div>
      <div class="opt-grid cols-4">${M.PATTERNS.map((o) => `<button class="opt" data-pattern="${o.id}" aria-pressed="${doc.pattern === o.id}" title="${o.note}"><span class="pat" data-pat="${o.id}"></span><span>${o.name}</span></button>`).join('')}</div></div>
      <div class="wb-group"><div class="wb-group-title">纹色 <em>${M.byId(M.INKS, doc.ink).name}</em></div>
      <div class="opt-grid cols-4">${M.INKS.map((o) => `<button class="opt" data-ink="${o.id}" aria-pressed="${doc.ink === o.id}" ${doc.pattern === 'plain' ? 'disabled' : ''}><span class="sw" style="${sw(o.rgb)}"></span><span>${o.name}</span></button>`).join('')}</div></div>`;
  } else {
    body = `<p class="lede">千三百度窑火之后，釉色才真正显现。为它取个名字、落款，然后点火。</p>
      <p class="wb-summary">${M.summary(doc)}</p>
      <label class="field"><span>器名</span><input id="wb-name" maxlength="16" value="${escapeHtml(doc.name && doc.name !== '未命名的器' ? doc.name : M.suggestName(doc))}"></label>
      <label class="field"><span>落款</span><input id="wb-author" maxlength="12" placeholder="可留空" value="${escapeHtml(prefs.get('author', ''))}"></label>
      <button class="pill-btn pill-strong next" data-fire>点火入窑 <span aria-hidden="true">›</span></button>
      <div class="wb-export"><span>另存：</span><button class="link-btn" data-export="png">图片</button><button class="link-btn" data-export="obj">三维模型</button><button class="link-btn" data-export="json">工程文件</button><button class="link-btn" data-import>打开工程</button></div>`;
  }
  panel.innerHTML = head + body + nextBtn;
  panel.dataset.step = step;
  bindPanel(panel);
}
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function bindPanel(panel) {
  const on = (sel, fn) => panel.querySelectorAll(sel).forEach((b) => b.addEventListener('click', () => fn(b)));
  on('[data-step-to]', (b) => setStep(b.dataset.stepTo));
  on('[data-clay]', (b) => tools([{ tool: 'set_material', arguments: { material: b.dataset.clay } }]));
  on('[data-form]', (b) => tools([{ tool: 'set_base_shape', arguments: { shape: b.dataset.form } }]));
  on('[data-reset]', () => tools([{ tool: 'set_base_shape', arguments: { shape: doc.preset } }]));
  on('[data-tool]', (b) => setTool(b.dataset.tool));
  on('[data-area]', (b) => { outlineArea = b.dataset.area; renderPanel(); });
  on('[data-outline]', (b) => tools([{ tool: 'set_cross_section', arguments: { part: outlineArea, shape: b.dataset.outline } }]));
  on('[data-glaze]', (b) => tools([{ tool: 'set_glaze', arguments: { glaze: b.dataset.glaze } }]));
  on('[data-pattern]', (b) => tools([{ tool: 'set_glaze', arguments: { pattern: b.dataset.pattern } }]));
  on('[data-ink]', (b) => tools([{ tool: 'set_glaze', arguments: { ink: b.dataset.ink } }]));
  on('[data-crackle]', () => tools([{ tool: 'set_glaze', arguments: { crackle: !doc.crackle } }]));
  on('[data-gesture]', () => (gesture.active ? gesture.stop() : gesture.start()));
  on('[data-fire]', fire);
  on('[data-export]', (b) => exportArtifact(b.dataset.export).then((a) => { download(a.blob, a.filename); app.toast('已保存 ' + a.filename); }).catch((e) => app.toast(e.message)));
  on('[data-import]', () => $('#wb-file').click());
  panel.querySelectorAll('.pat').forEach((el) => el.appendChild(patternThumb(el.dataset.pat, doc)));
  const name = panel.querySelector('#wb-name');
  if (name) name.addEventListener('change', () => change((d) => { d.name = name.value.trim() || M.suggestName(doc); }));
  panel.querySelectorAll('input[type="range"]').forEach((r) => {
    const out = r.parentElement.querySelector('output');
    const k = r.dataset.r;
    r.addEventListener('input', () => {
      out.textContent = r.value;
      if (k === 'brush') brush = +r.value;
      else if (k === 'strength') strength = +r.value;
      else if (k === 'height') { beginEdit(); doc.height = +r.value; rebuild(); layout(); }
      else if (k === 'gloss') { beginEdit(); doc.gloss = +r.value; surface.update(doc, rows); }
      else if (k === 'speed') { beginEdit(); doc.wheel.speed_rpm = +r.value; }
    });
    r.addEventListener('change', () => {
      const v = +r.value;
      if (['height', 'gloss', 'speed'].includes(k)) { commitEdit(); if (k === 'height') renderPanel(); }
      else if (k === 'diameter') tools([{ tool: 'set_dimensions', arguments: { diameter_cm: v } }]);
      else if (k === 'roundness') tools([{ tool: 'set_cross_section', arguments: { part: outlineArea, roundness: v / 100 } }]);
      else if (k === 'aspect') tools([{ tool: 'set_cross_section', arguments: { part: outlineArea, aspect_ratio: v } }]);
    });
  });
}

function setTool(id) {
  tool = id;
  $$('#wb-panel [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
}

function updateTools() {
  $('#wb-undo').disabled = !(remoteHistory && agent.online ? remoteHistory.undo : undoStack.length);
  $('#wb-redo').disabled = !(remoteHistory && agent.online ? remoteHistory.redo : redoStack.length);
  $('#wb-zoom').textContent = Math.round(zoom * 100) + '%';
  const w = $('#wb-wheel');
  w.setAttribute('aria-pressed', String(doc.wheel.rotating));
  w.textContent = doc.wheel.rotating ? '转盘：转' : '转盘：停';
}

function setZoom(z) {
  zoom = clamp(z, 0.8, 1.9);
  doc.view.zoom_percent = Math.round(clamp(zoom * 100, 57, 190));
  layout();
  updateTools();
}

function setTopOpen(open, user = true) {
  topOpen = open;
  $('#wb-top').hidden = !open;
  $('#wb-topview').setAttribute('aria-pressed', String(open));
  $('#wb-top-name').textContent = G.NAMES[doc.cross_section.shape] + (doc.section_bands.length ? ' · 局部另有形状' : '');
  if (open) {
    const box = $('#wb-top-view');
    topRenderer.setSize(box.clientWidth || 180, box.clientHeight || 180, false);
  }
  if (user) record(() => { doc.view = { ...doc.view, direction: open ? 'top' : 'perspective', ...M.VIEWS[open ? 'top' : 'perspective'] }; });
}

// ---------- 塑形与转盘 ----------
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), plane = new THREE.Plane(), planePoint = new THREE.Vector3(), cameraRight = new THREE.Vector3(1, 0, 0);

function setRay(x, y) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}
function hitPot(x, y) { setRay(x, y); return raycaster.intersectObject(pot, false)[0]; }
function planeAt(x, y) {
  setRay(x, y);
  plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), new THREE.Vector3());
  return raycaster.ray.intersectPlane(plane, planePoint) ? planePoint.clone() : null;
}

function showBrush(y) {
  const local = clamp(y, 0.025, doc.height / 6), row = Math.min(95, Math.round((local / (doc.height / 6)) * 95)), points = [];
  for (let i = 0; i < G.SEGMENTS; i++) {
    const a = (i / G.SEGMENTS) * Math.PI * 2 + pot.rotation.y, r = rows[row][i] + 0.012;
    points.push(new THREE.Vector3(Math.sin(a) * r, local, Math.cos(a) * r));
  }
  const old = brushRing.geometry;
  brushRing.geometry = new THREE.BufferGeometry().setFromPoints(points);
  old.dispose();
  brushRing.visible = true;
}

function applySculpt(y, delta) {
  const h = doc.height / 6;
  if (y < 0.06 || y > h + 0.05) return;
  const layer = clamp(y / h, 0, 1) * (M.N - 1), tw = TOOLS.find((t) => t.id === tool).w, sigma = (2 + brush * 0.14) * tw, power = strength / 45;
  const original = doc.profile.slice();
  for (let i = 1; i < M.N; i++) {
    const weight = Math.exp(-((i - layer) ** 2) / (2 * sigma * sigma));
    if (weight < 0.002) continue;
    let amount = delta * power * weight;
    if (tool === 'smooth') {
      const lo = Math.max(0, i - 3), hi = Math.min(M.N - 1, i + 3);
      let total = 0;
      for (let k = lo; k <= hi; k++) total += original[k];
      amount = (total / (hi - lo + 1) - original[i]) * 0.48 * power * weight;
    }
    if (tool === 'carve') amount = -0.012 * power * weight;
    doc.profile[i] = clamp(original[i] + amount, 0.32, 2.9);
  }
  const b = G.stats(doc);
  if (b.min_radius < 0.14 - 1e-8 || b.max_radius > 2.9 + 1e-8) { doc.profile = original; return; }
  rebuild();
  showBrush(y);
}

function onDown(e) {
  if (firing || (e.button !== 0 && e.button !== 2)) return;
  renderer.domElement.setPointerCapture(e.pointerId);
  lastInput = performance.now();
  $('#wb-drag-hint').classList.add('off');
  const hit = step === 'form' && !gesture.active && e.button === 0 && !e.shiftKey ? hitPot(e.clientX, e.clientY) : null;
  if (hit) {
    beginEdit();
    const p = planeAt(e.clientX, e.clientY);
    if (!p) return;
    interaction = { kind: 'sculpt', point: p, side: Math.sign(hit.point.x) || 1 };
    showBrush(hit.point.y);
  } else {
    interaction = { kind: 'turn', x: e.clientX, v: 0 };
    wrap.classList.add('dragging');
  }
}
function onMove(e) {
  if (!interaction) {
    if (step === 'form' && !gesture.active && e.pointerType === 'mouse') {
      const hit = hitPot(e.clientX, e.clientY);
      wrap.classList.toggle('over-pot', !!hit);
      if (hit) showBrush(hit.point.y); else brushRing.visible = false;
    }
    return;
  }
  lastInput = performance.now();
  if (interaction.kind === 'sculpt') {
    const p = planeAt(e.clientX, e.clientY);
    if (!p) return;
    applySculpt(p.y, (p.x - interaction.point.x) * interaction.side);
    interaction.point = p;
  } else {
    const dx = e.clientX - interaction.x;
    interaction.x = e.clientX;
    interaction.v = dx * 0.008;
    pot.rotation.y += interaction.v;
  }
}
function onUp() {
  if (interaction?.kind === 'sculpt') { commitEdit(); surface.update(doc, rows); }
  if (interaction?.kind === 'turn') { spin = interaction.v; notify(); }
  interaction = null;
  wrap.classList.remove('dragging');
  brushRing.visible = false;
}

// ---------- 摄像头手势（选用；需要联网加载 MediaPipe） ----------
const HANDS_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/';
const gesture = {
  active: false, stream: null, hands: null, token: 0, frame: 0, busy: false, session: false, lost: 0, smooth: {},
  async start() {
    if (this.active) return;
    const token = ++this.token;
    this.active = true;
    $('#wb-camera').hidden = false;
    $('#wb-gesture').setAttribute('aria-pressed', 'true');
    setStatus('正在请求摄像头权限…');
    if (step !== 'form') setStep('form'); else renderPanel();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('当前浏览器无法启用摄像头');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      if (token !== this.token) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      const video = $('#wb-webcam');
      video.srcObject = stream;
      await video.play();
      setStatus('正在加载手势识别…');
      await loadHands();
      if (token !== this.token) return;
      if (!this.hands) {
        this.hands = new window.Hands({ locateFile: (f) => HANDS_ROOT + f });
        this.hands.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.65, minTrackingConfidence: 0.65 });
        this.hands.onResults((r) => this.onResults(r));
      }
      setStatus('把双手放进画面，放在坯体左右两侧');
      const track = async () => {
        if (token !== this.token) return;
        if (!this.busy && video.readyState >= 2) {
          this.busy = true;
          try { await this.hands.send({ image: video }); } catch { if (token === this.token) { this.stop(); app.toast('手势识别加载失败，已切回鼠标'); } return; } finally { this.busy = false; }
        }
        if (token === this.token) this.frame = requestAnimationFrame(track);
      };
      track();
    } catch (e) {
      if (token !== this.token) return;
      this.stop();
      app.toast(e.name === 'NotAllowedError' ? '摄像头权限未获允许' : e.name === 'NotFoundError' ? '没有检测到摄像头' : e.message || '摄像头启动失败');
    }
  },
  stop() {
    this.token++;
    cancelAnimationFrame(this.frame);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    $('#wb-webcam').srcObject = null;
    $('#wb-camera').hidden = true;
    this.release();
    Object.assign(this, { active: false, smooth: {} });
    handMarks.forEach((m) => { m.visible = false; });
    $('#wb-gesture').setAttribute('aria-pressed', 'false');
    brushRing.visible = false;
    if (app.scene === 'workbench') renderPanel();
  },
  /** 双手拉坯：手的位置换算到坯体旁的竖直平面。两手贴上坯体后，两手之间的距离就是这一处的宽度。 */
  onResults(results) {
    if (!this.active) return;
    const overlay = $('#wb-hand');
    overlay.width = 320; overlay.height = 240;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, 320, 240);
    const h = doc.height / 6;
    // 画面左右镜像，你的右手出现在右边；画面横向 ±4.5 单位（约 ±27 厘米），纵向覆盖整个器高
    const hands = (results.multiHandLandmarks || []).map((lm) => {
      const pts = [0, 5, 9, 13, 17].map((i) => lm[i]);
      const cx = pts.reduce((a, p) => a + p.x, 0) / 5, cy = pts.reduce((a, p) => a + p.y, 0) / 5;
      return { lm, x: (0.5 - cx) * 9, y: clamp((0.85 - cy) / 0.7, 0, 1.05) * h };
    });
    // 按左右分开，各自平滑，减少抖动
    for (const hand of hands) {
      const side = hand.x < 0 ? 'L' : 'R', prev = this.smooth[side];
      if (prev) { hand.x = prev.x + (hand.x - prev.x) * 0.45; hand.y = prev.y + (hand.y - prev.y) * 0.45; }
      this.smooth[side] = { x: hand.x, y: hand.y };
    }
    if (!hands.length) this.smooth = {};
    const surfaceAt = (y) => doc.profile[Math.round(clamp(y / h, 0, 1) * 95)];
    const touching = hands.filter((hd) => hd.y > 0.02 && hd.y < h && Math.abs(Math.abs(hd.x) - surfaceAt(hd.y)) < 0.6);
    if (!this.session && touching.length) { beginEdit(); this.session = true; }
    if (this.session && !hands.length && ++this.lost > 4) this.release();
    if (hands.length) this.lost = 0;

    for (const hd of hands) {
      ctx.fillStyle = this.session ? '#f4dcaa' : 'rgba(238,228,207,.7)';
      for (const q of hd.lm) { ctx.beginPath(); ctx.arc(q.x * 320, q.y * 240, 2.4, 0, Math.PI * 2); ctx.fill(); }
    }
    handMarks.forEach((m, i) => {
      const hd = hands[i];
      m.visible = !!hd;
      if (hd) { m.position.set(hd.x, hd.y, 0.6); m.material.opacity = this.session ? 1 : 0.45; m.scale.setScalar(this.session ? 1.3 : 1); }
    });

    if (!hands.length) { brushRing.visible = false; setStatus('把双手放进画面，放在坯体左右两侧'); return; }
    const y = hands.reduce((a, hd) => a + hd.y, 0) / hands.length;
    if (!this.session) {
      brushRing.visible = y > 0 && y < h;
      if (brushRing.visible) showBrush(y);
      setStatus(hands.length > 1 ? '双手靠近坯体两侧，贴上去就开始塑形' : '另一只手也放进来，或单手贴近坯体');
      return;
    }
    // 两手在两侧：取两手到中轴距离的平均作为目标半径；单手时就用这只手
    const target = clamp(hands.reduce((a, hd) => a + Math.abs(hd.x), 0) / hands.length, 0.4, 2.8);
    if (y < 0.04 || y > h + 0.05) { brushRing.visible = false; setStatus('手移出了坯体的高度范围'); return; }
    const layer = clamp(y / h, 0, 1) * (M.N - 1), sigma = 2 + brush * 0.14, k = 0.2 * (strength / 45);
    const original = doc.profile.slice();
    for (let i = 1; i < M.N; i++) {
      const w = Math.exp(-((i - layer) ** 2) / (2 * sigma * sigma));
      if (w > 0.002) doc.profile[i] = clamp(original[i] + (target - original[i]) * k * w, 0.32, 2.9);
    }
    const st = G.stats(doc);
    if (st.min_radius < 0.14 - 1e-8 || st.max_radius > 2.9 + 1e-8) doc.profile = original;
    else { rebuild(); showBrush(y); }
    const now = surfaceAt(y);
    setStatus(target > now + 0.05 ? '双手分开 · 正在放宽' : target < now - 0.05 ? '双手合拢 · 正在收窄' : '正在塑形 · 分开变宽，合拢变窄，上下移动换位置');
  },
  release() {
    if (this.session) { commitEdit(); surface.update(doc, rows); }
    this.session = false;
    this.lost = 0;
  },
};
function setStatus(t) { $('#wb-gesture-status').textContent = t; }
function loadHands() {
  if (window.Hands) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HANDS_ROOT + 'hands.js';
    s.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { s.remove(); reject(Error('手势组件加载超时，请检查网络')); }, 20000);
    s.onload = () => { clearTimeout(timer); window.Hands ? resolve() : reject(Error('手势组件无法加载')); };
    s.onerror = () => { clearTimeout(timer); s.remove(); reject(Error('手势组件无法加载，请检查网络')); };
    document.head.appendChild(s);
  });
}

// ---------- 光柱里的浮尘 ----------
function initMotes() {
  fx = $('#wb-fx');
  fctx = fx.getContext('2d');
  sprite = glowSprite('255,214,160', 32);
  const r = rng(31);
  motes = Array.from({ length: 70 }, () => ({ x: 700 + r() * 270, y: r() * 640, s: 0.6 + r() * 1.8, v: 0.04 + r() * 0.12, p: r() * 6.28, a: 0.25 + r() * 0.55 }));
}
function drawMotes(now) {
  if (!view || app.reduced) { fctx?.clearRect(0, 0, fx.width, fx.height); return; }
  fitCanvas(fx);
  const dpr = fx.width / fx.clientWidth;
  fctx.clearRect(0, 0, fx.width, fx.height);
  fctx.globalCompositeOperation = 'lighter';
  for (const m of motes) {
    m.y -= m.v; m.p += 0.01;
    if (m.y < 0) { m.y = 640; }
    const x = m.x + Math.sin(m.p + now * 0.0003) * 14 + (m.y / 640 - 0.5) * 60;
    const [sx, sy] = toScreen(x, m.y);
    const size = m.s * 6 * view.S * dpr, k = 0.6 + 0.4 * Math.sin(now * 0.002 + m.p * 3);
    fctx.globalAlpha = m.a * k * Math.min(1, m.y / 120);
    fctx.drawImage(sprite, sx * dpr - size / 2, sy * dpr - size / 2, size, size);
  }
  fctx.globalAlpha = 1;
  fctx.globalCompositeOperation = 'source-over';
}

// ---------- 渲染循环 ----------
function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - (frame.t || now)) / 1000);
  frame.t = now;
  if (!interaction) {
    if (doc.wheel.rotating && !app.reduced && !firing) pot.rotation.y += (dt * doc.wheel.speed_rpm / 60) * Math.PI * 2;
    if (Math.abs(spin) > 0.0002) { pot.rotation.y += spin; spin *= 0.92; }
  }
  marker.rotation.y = pot.rotation.y;
  if (intro) intro(now);
  renderer.render(scene, camera);
  if (topOpen) {
    const h = doc.height / 6, s = Math.max(1.6, G.stats(doc, rows).max_radius * 1.25);
    topCamera.left = -s; topCamera.right = s; topCamera.top = s; topCamera.bottom = -s;
    topCamera.position.set(0, h + 20, 0);
    topCamera.lookAt(0, 0, 0);
    topCamera.updateProjectionMatrix();
    marker.visible = false;
    topRenderer.render(scene, topCamera);
    marker.visible = true;
  }
  drawMotes(now);
}

/** 进场：坯体从台面“长”出来。 */
function playIntro() {
  if (app.reduced) { pot.scale.set(1, 1, 1); return; }
  const t0 = performance.now();
  pot.scale.set(0.6, 0.001, 0.6);
  intro = (now) => {
    const t = clamp((now - t0) / 1500), e = 1 - Math.pow(1 - t, 3);
    pot.scale.set(0.6 + 0.4 * e, Math.max(0.001, e), 0.6 + 0.4 * e);
    if (t >= 1) intro = null;
  };
}

// ---------- 入窑与分享 ----------
async function fire() {
  if (firing) return;
  const nameEl = $('#wb-name'), authorEl = $('#wb-author');
  const name = (nameEl?.value || '').trim() || M.suggestName(doc), author = (authorEl?.value || '').trim();
  prefs.set('author', author);
  if (name !== doc.name) record(() => { doc.name = name; });
  firing = true;
  agent.stopVoice();
  gesture.stop();
  const sc = $('#scene-workbench');
  sc.classList.add('firing');
  const kiln = $('#wb-kiln'), cap = $('#wb-caption');
  const say = async (text, ms) => { cap.textContent = text; cap.classList.add('on'); await wait(ms); cap.classList.remove('on'); await wait(300); };
  kiln.classList.add('on');
  const mats = [surface.outer, surface.inner];
  mats.forEach((m) => { m.emissive = new THREE.Color(1, 0.42, 0.12); });
  const heat = tween(app.reduced ? 600 : 4200, (_, t) => {
    const k = Math.sin(Math.PI * Math.min(1, t * 1.05));
    mats.forEach((m) => { m.emissiveIntensity = k * 0.55; });
    renderer.toneMappingExposure = 1 + k * 0.25;
  }, (x) => x);
  if (!app.reduced) {
    await say('入窑 · 升温', 900);
    await say('窑火 · 一千三百度', 900);
    await say(doc.glaze === 'none' ? '烧结 · 泥色渐深' : '还原 · 釉色渐成', 900);
  }
  await heat;
  mats.forEach((m) => { m.emissiveIntensity = 0; });
  renderer.toneMappingExposure = 1;
  kiln.classList.remove('on');
  await say('开窑', 700);
  const image = (await still({ text: true, name, author })).toDataURL('image/jpeg', 0.9);
  app.work = { ...getDocument(), name, author, image, summary: M.summary(doc), date: Date.now() };
  firing = false;
  sc.classList.remove('firing');
  app.go('share');
}

/** 合成一张 4:5 的作品图：画中的展台 + 当前的坯体（可加落款文字）。 */
async function still({ text = false, name = '', author = '' } = {}) {
  const W = 1080, H = 1350, cropW = DESIGN.h * (W / H), x0 = PLINTH.x - cropW / 2, k = W / cropW;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  bgImg = bgImg || await loadImage('assets/story/s9.jpg').catch(() => null);
  if (bgImg) g.drawImage(bgImg, x0, 0, cropW, DESIGN.h, 0, 0, W, H);
  else { g.fillStyle = '#0a0d0d'; g.fillRect(0, 0, W, H); }
  const pr = renderer.getPixelRatio(), was = brushRing.visible;
  brushRing.visible = false; marker.visible = false;
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  camera.setViewOffset(DESIGN.w * k, DESIGN.h * k, x0 * k, 0, W, H);
  renderer.render(scene, camera);
  g.drawImage(renderer.domElement, 0, 0, W, H);
  renderer.setPixelRatio(pr);
  brushRing.visible = was; marker.visible = true;
  layout();
  if (text) {
    const fade = g.createLinearGradient(0, H * 0.78, 0, H);
    fade.addColorStop(0, 'rgba(5,8,9,0)'); fade.addColorStop(1, 'rgba(5,8,9,.82)');
    g.fillStyle = fade; g.fillRect(0, H * 0.78, W, H * 0.22);
    await document.fonts?.ready;
    const serif = '"Noto Serif SC", "Songti SC", serif';
    g.textAlign = 'center';
    g.fillStyle = '#eee4cf'; g.font = `400 30px ${serif}`;
    g.fillText('承　艺', W / 2, 78);
    g.strokeStyle = 'rgba(214,180,122,.5)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(W / 2 - 70, 100); g.lineTo(W / 2 - 8, 100); g.moveTo(W / 2 + 8, 100); g.lineTo(W / 2 + 70, 100); g.stroke();
    g.beginPath(); g.arc(W / 2, 100, 5, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#f3ead6'; g.font = `400 52px ${serif}`;
    g.fillText(name, W / 2, 1180);
    g.fillStyle = 'rgba(238,228,207,.7)'; g.font = `400 24px ${serif}`;
    g.fillText(M.summary(doc), W / 2, 1228);
    const d = new Date();
    g.fillStyle = 'rgba(214,180,122,.88)'; g.font = `400 21px ${serif}`;
    g.fillText(`${author ? author + ' 制 · ' : ''}${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`, W / 2, 1272);
    g.fillStyle = 'rgba(238,228,207,.42)'; g.font = `400 18px ${serif}`;
    g.fillText('择土 · 练泥 · 成形 · 施釉 · 入窑', W / 2, 1320);
  }
  return c;
}

function objBlob() {
  const geo = pot.geometry, p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv, idx = geo.index;
  const lines = ['# 承艺 · 陶艺工作台', '# 单位：厘米', 'o ChengyiPottery'];
  for (let i = 0; i < p.count; i++) lines.push(`v ${(p.getX(i) * 6).toFixed(5)} ${(p.getY(i) * 6).toFixed(5)} ${(p.getZ(i) * 6).toFixed(5)}`);
  for (let i = 0; i < uv.count; i++) lines.push(`vt ${uv.getX(i).toFixed(6)} ${uv.getY(i).toFixed(6)}`);
  for (let i = 0; i < n.count; i++) lines.push(`vn ${n.getX(i).toFixed(6)} ${n.getY(i).toFixed(6)} ${n.getZ(i).toFixed(6)}`);
  for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i) + 1, b = idx.getX(i + 1) + 1, c = idx.getX(i + 2) + 1; lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`); }
  return new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
}

async function exportArtifact(format) {
  let blob;
  if (format === 'obj') blob = objBlob();
  else if (format === 'json') blob = new Blob([JSON.stringify({ format: 'chengyi-pottery', version: 3, ...getDocument() }, null, 2)], { type: 'application/json' });
  else if (format === 'png') { const c = await still(); blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png')); }
  else throw Error('没有这种导出格式');
  if (!blob?.size) throw Error('文件生成失败');
  const filename = `${(doc.name.trim() || '承艺作品').replace(/[\\/:*?"<>|]/g, '_')}.${format}`;
  return { blob, format, filename, bytes: blob.size };
}
function download(blob, filename) {
  const href = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

async function importFile(file) {
  try {
    if (file.size > 1024 * 1024) throw Error('工程文件超过 1 MB');
    const next = M.validate(JSON.parse(await file.text()));
    commitDocument(next);
    app.toast('工程文件已打开');
  } catch (e) {
    app.toast(e instanceof SyntaxError ? '文件无法读取，请选择承艺导出的工程文件' : e.message);
  }
}

// ---------- 给 AI 模块的接口 ----------
const bench = {
  getState: getDocument,
  applyState(next, history) {
    applyingRemote = true;
    try {
      commitEdit();
      doc = M.validate(next);
      pot.rotation.y = ((doc.wheel.rotation_deg || 0) * Math.PI) / 180;
      sync();
      if (history) remoteHistory = { undo: history.undo_count, redo: history.redo_count };
      updateTools();
      persist();
    } finally { applyingRemote = false; }
    return getDocument();
  },
  exportArtifact,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  setHistory(h) { remoteHistory = { undo: h.undo_count, redo: h.redo_count }; updateTools(); },
  prepareForCommand() { commitEdit(); },
  pauseForVoice() { if (doc.wheel.rotating) record(() => { doc.wheel.rotating = false; updateTools(); }); },
  isEditing: () => Boolean(editStart || interaction || gesture.session),
  commitDocument,
  undo, redo,
  afterAgent(command) {
    jumpToStepFor(command.actions || []);
  },
};

export const workbench = {
  init(a) {
    app = a;
    wrap = $('#wb-canvas-wrap');
    setupScene();
    initMotes();
    try { doc = M.validate(prefs.get('pottery', null)); } catch { doc = M.newDocument(); }
    pot.rotation.y = ((doc.wheel.rotation_deg || 0) * Math.PI) / 180;
    sync();
    renderSteps();
    const el = renderer.domElement;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('lostpointercapture', () => interaction && onUp());
    el.addEventListener('pointerleave', () => { if (!interaction) brushRing.visible = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    let zoomTimer;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.0012));
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(notify, 450);
    }, { passive: false });
    window.addEventListener('resize', () => app.scene === 'workbench' && layout());
    $('#wb-undo').addEventListener('click', undo);
    $('#wb-redo').addEventListener('click', redo);
    $('#wb-zoom-in').addEventListener('click', () => { setZoom(zoom * 1.12); notify(); });
    $('#wb-zoom-out').addEventListener('click', () => { setZoom(zoom / 1.12); notify(); });
    $('#wb-topview').addEventListener('click', () => setTopOpen(!topOpen));
    $('#wb-top-close').addEventListener('click', () => setTopOpen(false));
    $('#wb-wheel').addEventListener('click', () => record(() => { doc.wheel.rotating = !doc.wheel.rotating; updateTools(); }));
    $('#wb-camera-close').addEventListener('click', () => gesture.stop());
    $('#wb-gesture').addEventListener('click', () => (gesture.active ? gesture.stop() : gesture.start()));
    $('#wb-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importFile(f); e.target.value = ''; });
    window.addEventListener('keydown', (e) => {
      if (app.scene !== 'workbench' || firing || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); $('#wb-wheel').click(); }
      if (step === 'form' && '1234'.includes(e.key)) setTool(TOOLS[+e.key - 1].id);
    });
    window.addEventListener('pagehide', () => { prefs.set('pottery', getDocument()); gesture.stop(); });
    agent.init(app, bench);
  },
  async enter(opts = {}, prev) {
    app.setBrand('承艺');
    app.setBack(prev === 'share' ? '回到山河' : '返回篇章', () => (prev === 'share' ? app.go('map') : app.go('chapter', { keep: true })));
    $('#scene-workbench').classList.remove('firing');
    firing = false;
    if (opts.again) {
      doc = M.newDocument();
      undoStack = []; redoStack = [];
      pot.rotation.y = 0;
      sync();
      notify();
      persist();
    }
    running = true;
    // 从篇章进来时左侧五步与篇章结尾的流程线位置一致，逐个亮起
    const steps = $('#wb-steps');
    steps.classList.toggle('arrive', !opts.direct && !app.reduced);
    setStep(opts.again ? 'soil' : step);
    layout();
    cancelAnimationFrame(raf);
    frame.t = 0;
    raf = requestAnimationFrame(frame);
    if (opts.again || prev === 'chapter' || opts.direct) playIntro();
    lastInput = performance.now();
  },
  leave() {
    running = false;
    gesture.stop();
    agent.stopVoice();
    setTimeout(() => { if (!running) cancelAnimationFrame(raf); }, 900);
  },
  onReduced() { if (running) layout(); },
  // 便于调试与测试：读当前作品、直接喂入手部关键点
  getState: getDocument,
  gesture,
};
