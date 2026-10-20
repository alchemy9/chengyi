// 声音：只播放真实音频素材，不再用代码合成音色。
// - 过场视频自带的声轨：由 prologue.js 控制，结尾淡出，避免被截断
// - 环境声：把音频放进 assets/audio/ 并在 index.json 里登记后自动启用（循环、低音量、渐入渐出）；没有文件时保持安静
// 浏览器要求用户先操作页面才能出声，因此在第一次点击 / 按键时启动。

// assets/audio/index.json：{ "ambient": "ambient.mp3" }；值为 null 表示暂无环境声素材
const MANIFEST = 'assets/audio/index.json';
let AMBIENT_SRC = null;
const BASE_VOLUME = 0.35;

let ambient = null, available = null, level = 1, fadeRaf = 0, unlocked = false;

async function probe() {
  if (available !== null) return available;
  try {
    const m = await (await fetch(MANIFEST, { cache: 'no-cache' })).json();
    AMBIENT_SRC = m && m.ambient ? 'assets/audio/' + m.ambient : null;
    available = !!AMBIENT_SRC;
  } catch { available = false; }
  return available;
}

function fadeTo(target, seconds) {
  if (!ambient) return;
  cancelAnimationFrame(fadeRaf);
  const from = ambient.volume, t0 = performance.now(), ms = Math.max(1, seconds * 1000);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    ambient.volume = from + (target - from) * k;
    if (k < 1) fadeRaf = requestAnimationFrame(step);
    else if (target === 0) ambient.pause();
  };
  if (target > 0 && ambient.paused) ambient.play().catch(() => {});
  fadeRaf = requestAnimationFrame(step);
}

export const sound = {
  muted: false,
  /** 用户第一次操作后调用。返回是否已允许出声。 */
  unlock() {
    unlocked = true;
    if (this.muted) return true;
    probe().then((ok) => {
      if (!ok || this.muted) return;
      if (!ambient) {
        ambient = new Audio(AMBIENT_SRC);
        ambient.loop = true;
        ambient.volume = 0;
      }
      fadeTo(BASE_VOLUME * level, 3);
    });
    return true;
  },
  setMuted(m) {
    this.muted = m;
    if (!unlocked) return;
    if (m) fadeTo(0, 0.5); else this.unlock();
  },
  /** 过场视频播放时压低环境声；level 为相对基准的 0..1。 */
  duck(l, seconds = 0.8) {
    level = l;
    if (!ambient || this.muted) return;
    fadeTo(BASE_VOLUME * l, seconds);
  },
};
