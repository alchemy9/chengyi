// 入口：场景切换、顶部控件、全局设置（声音 / 减少动态）、评审直达地址。
import { $, prefs } from './util.js';
import { sound } from './sound.js';
import { prologue } from './prologue.js';
import { map } from './map.js';
import { closeup } from './closeup.js';
import { chapter } from './chapter.js';

const appEl = $('#app');
const sceneEls = {
  prologue: $('#scene-prologue'), map: $('#scene-map'), object: $('#scene-object'),
  chapter: $('#scene-chapter'), workbench: $('#scene-workbench'), share: $('#scene-share'),
};

const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

export const app = {
  scene: null,
  modules: { prologue, map, object: closeup, chapter },
  reduced: prefs.get('reduced', reducedQuery.matches),
  muted: prefs.get('muted', false),
  work: null, // 工作台完成后的作品，交给分享页

  async go(name, opts = {}) {
    const prev = this.scene;
    if (prev === name && !opts.force) return;
    const mod = await this.load(name);
    const prevMod = this.modules[prev === 'entering' ? 'prologue' : prev];
    if (prevMod?.leave) prevMod.leave(name);
    this.scene = name;
    appEl.dataset.scene = name;
    for (const [k, el] of Object.entries(sceneEls)) {
      el.classList.toggle('instant', !!opts.instant);
      el.classList.toggle('active', k === name);
    }
    if (opts.instant) requestAnimationFrame(() => Object.values(sceneEls).forEach((el) => el.classList.remove('instant')));
    this.setBack(null);
    this.setSkip(null);
    const hash = name === 'prologue' ? '' : '#' + name;
    try { history.replaceState(null, '', location.pathname + location.search + hash); } catch { /* 忽略 */ }
    await mod.enter?.(opts, prev);
  },

  async load(name) {
    if (this.modules[name]) return this.modules[name];
    if (name === 'workbench') this.modules.workbench = (await import('./workbench.js')).workbench;
    if (name === 'share') this.modules.share = (await import('./share.js')).share;
    const mod = this.modules[name];
    mod.init?.(this);
    mod._inited = true;
    return mod;
  },

  setBack(label, fn) {
    const b = $('#btn-back');
    b.hidden = !label;
    if (label) { b.querySelector('.back-label').textContent = label; b.onclick = fn; }
  },
  setSkip(label, fn) {
    const b = $('#btn-skip');
    if (label) { appEl.dataset.skip = '1'; b.textContent = label; b.onclick = fn; } else delete appEl.dataset.skip;
  },
  setBrand(text, show = true) {
    $('#brand-name').textContent = text;
    $('#brand').style.opacity = show ? '' : '0';
  },

  toast(msg, ms = 2400) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  },

  veil(on) { $('#veil').classList.toggle('on', on); },

  setReduced(v) {
    this.reduced = v;
    prefs.set('reduced', v);
    appEl.classList.toggle('reduced', v);
    const b = $('#btn-motion');
    b.textContent = v ? '动态：简化' : '动态：完整';
    b.setAttribute('aria-pressed', String(v));
    Object.values(this.modules).forEach((m) => m?._inited && m.onReduced?.(v));
  },

  setMuted(v) {
    this.muted = v;
    prefs.set('muted', v);
    sound.setMuted(v);
    const b = $('#btn-sound');
    b.textContent = v ? '声音：关' : '声音：开';
    b.setAttribute('aria-pressed', String(!v));
    Object.values(this.modules).forEach((m) => m?._inited && m.onMuted?.(v));
  },
};

// 顶部控件
$('#btn-sound').addEventListener('click', () => { app.setMuted(!app.muted); if (!app.muted) sound.unlock(); });
$('#btn-motion').addEventListener('click', () => app.setReduced(!app.reduced));
// 重播序章：回到序章初始状态，不清除工作台草稿
$('#btn-replay').addEventListener('click', () => app.go('prologue', { force: true }));

// 浏览器要求用户操作后才能出声：第一次操作时启动环境声
const unlockOnce = () => {
  sound.unlock();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);

// 页面切到后台：暂停声音；回来时恢复
document.addEventListener('visibilitychange', () => sound.duck(document.hidden ? 0 : 1, 0.4));

// 初始化
for (const [k, m] of Object.entries(app.modules)) { m.init?.(app); m._inited = true; }
sound.muted = app.muted;
app.setMuted(app.muted);
app.setReduced(app.reduced);
reducedQuery.addEventListener?.('change', (e) => app.setReduced(e.matches));

// 评审直达：#map #object #chapter #workbench
// 评审 / 截图参数：#chapter?p=0.45 直接停在篇章某一进度；#object?id=papercut 打开某件器物
const [start, query] = location.hash.replace('#', '').split('?');
const params = new URLSearchParams(query || '');
const direct = ['map', 'object', 'chapter', 'workbench'];
if (direct.includes(start)) {
  app.go(start, { instant: true, direct: true, id: params.get('id') || undefined }).then(() => {
    if (start === 'chapter' && params.has('p')) chapter.preload().then(() => chapter.seek(+params.get('p')));
  });
} else {
  app.go('prologue', { instant: true });
}

window.chengyi = app; // 便于调试
