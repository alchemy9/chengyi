// 分享：本期流程的终点。展示分享图，可保存图片、复制文案、调用系统分享。
// 公开链接与个人场馆待后续版本接入，这里不假装已发布。
import { $ } from './util.js';

let app;

function dataUrlToBlob(url) {
  const [head, body] = url.split(',');
  const mime = head.match(/:(.*?);/)[1];
  const bin = atob(body), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function shareText(w) {
  return `我在「承艺」做了一件瓷器：${w.name}（${w.summary}）。从一抔土到一件器，与 AI 一起，让心意成形。`;
}

export const share = {
  init(a) {
    app = a;
    $('#share-download').addEventListener('click', () => {
      const w = app.work;
      if (!w) return;
      const a = document.createElement('a');
      a.href = w.image;
      a.download = `承艺-${w.name.replace(/[\\/:*?"<>|·\s]+/g, '')}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      app.toast('分享图已保存');
    });
    $('#share-copy').addEventListener('click', async () => {
      const w = app.work;
      if (!w) return;
      try { await navigator.clipboard.writeText(shareText(w)); app.toast('分享文案已复制'); }
      catch { app.toast('浏览器不允许复制，请手动选择文字'); }
    });
    $('#share-native').addEventListener('click', async () => {
      const w = app.work;
      if (!w) return;
      try {
        const file = new File([dataUrlToBlob(w.image)], '承艺作品.jpg', { type: 'image/jpeg' });
        const data = { title: '承艺 · ' + w.name, text: shareText(w) };
        if (navigator.canShare?.({ files: [file] })) data.files = [file];
        await navigator.share(data);
      } catch (e) { if (e?.name !== 'AbortError') app.toast('系统分享暂不可用，可先保存分享图'); }
    });
    $('#share-again').addEventListener('click', () => app.go('workbench', { again: true }));
    $('#share-map').addEventListener('click', () => app.go('map'));
  },
  enter() {
    app.setBrand('承艺');
    const w = app.work;
    if (!w) { app.go('workbench'); return; }
    $('#share-img').src = w.image;
    $('#share-name').textContent = w.name;
    const d = new Date(w.date);
    $('#share-meta').innerHTML = `${w.summary}<br>${w.author ? w.author + ' 制 · ' : ''}${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    $('#share-native').hidden = !navigator.share;
  },
};
