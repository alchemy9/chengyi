// 序章：静置背景 + 克制的待机动效（金尘、光点呼吸、薄雾），叙事文字逐字显现，
// 结束后出现「寻光入境」引导；点击或下滚播放光核过场视频，结束进入地图。
import { $, cover, fitCanvas, glowSprite, rng, wait } from './util.js';
import { sound } from './sound.js';

const IMG = { w: 1672, h: 941 };
const CORE = { x: 836, y: 250 }; // 原图中光点位置

let app, el, canvas, ctx, video, raf = 0;
let phase = 'idle'; // playing | ready | entering | done
let timers = [];
let motes = [], fogs = [];
const sprite = glowSprite('255,214,150');
const fogSprite = glowSprite('110,150,150', 128);

function seed() {
  const r = rng(11);
  motes = Array.from({ length: 46 }, () => ({
    x: r(), y: r(), z: 0.25 + r() * 0.75, // z 越大越近：更大更快
    vx: (r() - 0.5) * 0.004, vy: -0.002 - r() * 0.004, tw: r() * Math.PI * 2, ts: 0.6 + r() * 1.4,
  }));
  fogs = Array.from({ length: 5 }, (_, i) => ({ x: 0.15 + r() * 0.7, y: 0.25 + r() * 0.6, r: 0.25 + r() * 0.25, a: 0.05 + r() * 0.05, ph: i * 1.7 }));
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  fitCanvas(canvas);
  const W = canvas.width, H = canvas.height, dpr = W / canvas.clientWidth;
  const t = now / 1000;
  ctx.clearRect(0, 0, W, H);
  const c = cover(canvas.clientWidth, canvas.clientHeight, IMG.w, IMG.h);
  const reduced = app.reduced;

  // 极淡的雾光缓慢移动
  ctx.globalCompositeOperation = 'lighter';
  for (const f of fogs) {
    const dx = reduced ? 0 : Math.sin(t * 0.05 + f.ph) * 0.05, dy = reduced ? 0 : Math.cos(t * 0.04 + f.ph) * 0.03;
    const R = f.r * W;
    ctx.globalAlpha = f.a * (0.7 + 0.3 * Math.sin(t * 0.13 + f.ph));
    ctx.drawImage(fogSprite, (f.x + dx) * W - R, (f.y + dy) * H - R * 0.6, R * 2, R * 1.2);
  }

  // 光点呼吸
  const cx = (c.x + CORE.x * c.s) * dpr, cy = (c.y + CORE.y * c.s) * dpr;
  const breathe = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(t * 1.1);
  const r0 = (18 + breathe * 10) * c.s * dpr;
  ctx.globalAlpha = 0.22 + breathe * 0.22;
  ctx.drawImage(sprite, cx - r0, cy - r0, r0 * 2, r0 * 2);
  ctx.globalAlpha = 0.5 + breathe * 0.3;
  const r1 = 5 * c.s * dpr;
  ctx.drawImage(sprite, cx - r1, cy - r1, r1 * 2, r1 * 2);

  // 金尘：少量、远近不同；避开中央文案带
  if (!reduced) {
    for (const m of motes) {
      m.x += m.vx * m.z * 0.016; m.y += m.vy * m.z * 0.016;
      if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); }
      if (m.x < -0.05) m.x = 1.05; if (m.x > 1.05) m.x = -0.05;
    }
  }
  for (const m of motes) {
    const px = m.x * W, py = m.y * H;
    const band = Math.abs(m.y - 0.52) < 0.09 && Math.abs(m.x - 0.5) < 0.25 ? 0.25 : 1;
    const s = (1.2 + m.z * m.z * 7) * dpr * (m.z > 0.85 ? 2.2 : 1);
    ctx.globalAlpha = band * (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * m.ts + m.tw))) * (m.z > 0.85 ? 0.35 : 0.9);
    ctx.drawImage(sprite, px - s, py - s, s * 2, s * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function clearTimers() { timers.forEach(clearTimeout); timers = []; }
const later = (ms, fn) => timers.push(setTimeout(fn, app.reduced ? Math.min(ms, 300) : ms));

function playNarrative() {
  phase = 'playing';
  const title = $('#prologue-title');
  const chars = title.querySelectorAll('.ch');
  chars.forEach((c) => c.classList.remove('on'));
  $('#prologue-sub').classList.remove('on');
  $('#enter-guide').classList.remove('on');
  el.classList.remove('leaving');
  chars.forEach((c, i) => later(700 + i * 150, () => c.classList.add('on')));
  later(700 + chars.length * 150 + 500, () => $('#prologue-sub').classList.add('on'));
  later(700 + chars.length * 150 + 2100, () => { $('#enter-guide').classList.add('on'); phase = 'ready'; });
}

// 视频最后约一秒镜头基本静止，取景与地图底图一致（见 data.js 的 VIDEO_TO_MAP），从这里开始交叉淡化
const HANDOFF_AT = 9.0;
const AUDIO_FADE = 1.4; // 结尾声音淡出时长（秒），避免声轨被截断

async function enterMap() {
  if (phase !== 'ready' && phase !== 'playing') return;
  phase = 'entering';
  clearTimers();
  el.classList.add('leaving');
  $('#btn-enter').disabled = true;
  app.scene = 'entering';
  document.getElementById('app').dataset.scene = 'entering';
  app.setSkip('跳过', () => finish(true));

  if (app.reduced) { await wait(300); return finish(true); }

  sound.duck(0.2, 1.2);
  video.muted = app.muted;
  video.volume = 1;
  video.currentTime = 0;
  let ok = false;
  try {
    await video.play();
    ok = true;
  } catch {
    // 有声播放被拒时改为静音再试
    try { video.muted = true; await video.play(); ok = true; } catch { ok = false; }
  }
  if (!ok) { app.toast('过场视频暂时无法播放，已直接进入山河'); return finish(true); }
  video.classList.add('on');
  // 地图提前按视频尾帧的取景摆好，放在视频上方、完全透明
  app.modules.map.prepareHandoff();
  const tick = () => {
    if (phase !== 'entering') return;
    const t = video.currentTime, d = video.duration || 10.06;
    video.volume = Math.max(0, Math.min(1, (d - t) / AUDIO_FADE));
    if (t >= HANDOFF_AT) app.modules.map.handoff((t - HANDOFF_AT) / (d - HANDOFF_AT));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  video.onended = () => finish(false);
  // 卡顿保护：超出视频时长较多仍未结束则直接进入
  timers.push(setTimeout(() => phase === 'entering' && finish(true), (video.duration || 10) * 1000 + 4000));
}

/** skipped：用户跳过或播放失败时为 true，此时地图直接淡入；正常播完则地图已经叠在视频上。 */
function finish(skipped) {
  if (phase === 'done') return;
  phase = 'done';
  clearTimers();
  video.onended = null;
  sound.duck(1, 2.5);
  app.go('map', { fromVideo: !skipped, reveal: true }).then(() => {
    setTimeout(() => { video.pause(); video.classList.remove('on'); }, 1000);
  });
}

export const prologue = {
  init(a) {
    app = a;
    el = $('#scene-prologue');
    canvas = $('#prologue-fx');
    ctx = canvas.getContext('2d');
    video = $('#enter-video');
    seed();
    // 主文案拆成单字，逐字显现
    const title = $('#prologue-title');
    title.innerHTML = [...title.textContent].map((c) => `<span class="ch" aria-hidden="true">${c}</span>`).join('');
    $('#btn-enter').addEventListener('click', enterMap);
    el.addEventListener('wheel', (e) => { if (e.deltaY > 8 && phase === 'ready') enterMap(); }, { passive: true });
    let ty = null;
    el.addEventListener('touchstart', (e) => { ty = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchmove', (e) => { if (ty !== null && ty - e.touches[0].clientY > 40 && phase === 'ready') { ty = null; enterMap(); } }, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (app.scene !== 'prologue') return;
      if (['ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key) && phase === 'ready' && document.activeElement?.id !== 'btn-enter') enterMap();
    });
    video.addEventListener('error', () => { if (phase === 'entering') { app.toast('过场视频加载失败，已直接进入山河'); finish(true); } });
  },
  enter() {
    $('#btn-enter').disabled = false;
    el.classList.remove('leaving');
    video.classList.remove('on');
    video.pause();
    phase = 'idle';
    app.setBrand('承艺');
    app.setSkip('跳过', () => finish(true));
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
    playNarrative();
  },
  leave() {
    clearTimers();
    setTimeout(() => cancelAnimationFrame(raf), 1000);
  },
  onMuted(m) { video.muted = m; },
};
