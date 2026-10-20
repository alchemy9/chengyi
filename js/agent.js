// 承艺 AI：工作台底部的对话条。
// 联网时连接本项目后台（server/）：文字或语音 → 后台规则 / Dify Agent 规划工具调用 → 网页执行并回执 → 朗读回复。
// 后台不可用（例如只用 tools/serve.py 预览网页）或 Agent 无法回答时，退回本机关键词规则，手动修改照常保存。
import { $ } from './util.js';
import { PCMPlayer } from './voice/pcm-player.js';
import { applyLocal } from './pottery/model.js';

const API = (window.CHENGYI_API_BASE || '') + '/api/v1';
const KEY = 'chengyi3-workbench-session', DIRTY = 'chengyi3-workbench-pending';

let app, bench;
let credentials = null, project = null, online = false, busy = false, closed = false;
let generation = 0, network = null, audioNetwork = null, recognition = null;
let serial = Promise.resolve(), snapshots = [], syncing = false, syncError = null, applying = false;
const executed = new Set(), files = [];
let player = null, pollTimer = 0;

// ---------- 界面 ----------
function status(text, kind = '') {
  const el = $('#ai-status');
  el.textContent = text;
  el.dataset.kind = kind;
}
function progress(text) { $('#ai-progress').textContent = text || ''; }

function message(text, kind = '', source = '') {
  const log = $('#ai-msgs');
  const p = document.createElement('p');
  p.className = 'ai-msg ' + kind;
  p.textContent = text;
  if (source) { const s = document.createElement('span'); s.className = 'ai-src'; s.textContent = source; p.append(s); }
  log.append(p);
  while (log.children.length > 6) log.firstElementChild.remove();
  $('#ai-log').hidden = false;
  log.scrollTop = log.scrollHeight;
  collapseLater();
}

/** 对话框停留一会儿后自动收起，免得一直挡住展台；鼠标停在上面时不收。 */
let collapseTimer = 0;
function collapseLater() {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if ($('#ai-log').matches(':hover') || busy) collapseLater();
    else $('#ai-log').hidden = true;
  }, 14000);
}

function setBusy(v) {
  busy = v;
  $('#ai-send').disabled = v;
  $('#ai-mic').disabled = (v && !recording) || !online || !project;
  $('#ai-stop').hidden = !v && !audioNetwork;
  $('#scene-workbench').classList.toggle('ai-busy', v);
}

// ---------- 后台接口 ----------
async function api(path, body, signal) {
  const res = await fetch(API + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(credentials ? { 'X-Session-Token': credentials.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  let value = null;
  try { value = await res.json(); } catch { /* 非 JSON：多半是静态服务器 */ }
  if (!res.ok || !value) {
    const err = Error(value?.error?.message || '后台请求没有完成');
    err.status = res.status;
    throw err;
  }
  return value.data;
}
const route = (suffix = '') => '/workbenches/' + project.id + suffix;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));

function storeSession() {
  try { sessionStorage.setItem(KEY, JSON.stringify({ id: project.id, token: credentials.token })); } catch { /* 忽略 */ }
}
function accept(value, { render = false } = {}) {
  project = value.project;
  bench.setHistory(project);
  if (render) {
    applying = true;
    try { bench.applyState(project.document, project); } finally { applying = false; }
  }
  storeSession();
}
function inSerial(fn) {
  const next = serial.then(fn, fn);
  serial = next.catch(() => {});
  return next;
}

async function connect() {
  status('正在连接…');
  try {
    try { credentials = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { credentials = null; }
    let value;
    if (credentials) {
      try { value = await api('/workbenches/' + credentials.id); } catch (e) {
        if (![404, 410, 401, 422].includes(e.status)) throw e;
        credentials = null;
      }
    }
    let dirty = null;
    try { dirty = sessionStorage.getItem(DIRTY); } catch { /* 忽略 */ }
    if (!value) {
      value = await api('/workbenches', { document: bench.getState() });
      credentials = { token: value.session_token };
      accept(value);
      try { sessionStorage.removeItem(DIRTY); } catch { /* 忽略 */ }
    } else {
      // 本机草稿比后台新时以本机为准，同步上去；否则载入后台文档
      accept(value);
      accept(await api(route('/cancel'), {}));
      snapshots.push(dirty ? JSON.parse(dirty) : bench.getState());
      await flushSnapshots();
    }
    online = true;
    const health = await fetch((window.CHENGYI_API_BASE || '') + '/health').then((r) => r.json()).catch(() => null);
    const live = health?.data?.llm_mode === 'live';
    status(live ? 'Agent 已连接' : '后台已连接 · 规则模式', 'on');
    $('#ai-input').placeholder = live
      ? '说说你的心意：做个爱心碗、瓶口收一点、施天青釉配缠枝莲…'
      : '试试：做个茶碗、高度改成 20 厘米、施天青釉、加缠枝莲纹…';
    startPolling();
  } catch (e) {
    online = false;
    project = null;
    status('本机演示 · 关键词理解', 'off');
    $('#ai-input').placeholder = '说说你的心意：想要修长的天青瓶，配缠枝莲…';
  }
  setBusy(false);
}

async function flushSnapshots() {
  if (syncing) return;
  syncing = true;
  try {
    while (snapshots.length) {
      const body = { expected_revision: project.revision, client_request_id: uuid(), document: snapshots[0] };
      let value;
      try { value = await api(route('/sync'), body); } catch (e) {
        if (e.status !== 409) throw e;
        accept(await api(route('/cancel'), {}));
        body.expected_revision = project.revision;
        value = await api(route('/sync'), body);
      }
      snapshots.shift();
      accept(value);
      if (!snapshots.length) { try { sessionStorage.removeItem(DIRTY); } catch { /* 忽略 */ } }
    }
    syncError = null;
  } catch (e) {
    syncError = e;
    progress('修改已保存在本机，后台同步未完成：' + e.message);
    throw e;
  } finally {
    syncing = false;
  }
}

/** 手动修改：同步到后台（作为一条可撤销的记录）。 */
function onManualChange(doc) {
  if (applying || closed || !online) return;
  generation++;
  network?.abort();
  recognition?.abort();
  stopAudio();
  snapshots.push(doc);
  try { sessionStorage.setItem(DIRTY, JSON.stringify(doc)); } catch { /* 忽略 */ }
  if (!project) return;
  void inSerial(async () => {
    if (!snapshots.length) return;
    accept(await api(route('/cancel'), {}));
    await flushSnapshots();
  }).catch(() => {});
}

const SOURCES = { dify: 'Dify Agent', model: '大模型', local: '后台规则', tool: '工具调用', manual: '手动' };

async function applyCommand(command, gen) {
  if (command.status === 'answered') {
    message(command.message, '', (SOURCES[command.source] || '助手') + ' · 回答');
    void speak(command.id);
    return;
  }
  if (command.status !== 'pending' || executed.has(command.id)) return;
  if (gen !== generation || command.revision !== project.revision || Date.parse(command.expires_at) <= Date.now()) throw Error('作品刚刚有变化，旧指令已取消。');
  const before = bench.getState(), artifacts = [];
  try {
    applying = true;
    $('#scene-workbench').classList.add('remote-applying');
    bench.applyState(command.document);
    // 导出的是网页里真实的模型与画面，不使用模型给出的任何链接
    for (const effect of command.effects) if (effect.type === 'export_artifact') artifacts.push(await bench.exportArtifact(effect.format));
    if (gen !== generation) throw Error('作品发生变化，本次操作已取消。');
    const receipt = {
      expected_revision: command.revision, status: 'applied', document: bench.getState(),
      artifacts: artifacts.map(({ format, filename, bytes }) => ({ format, filename, bytes })),
    };
    let value;
    try { value = await api(route('/commands/' + command.id + '/receipt'), receipt); } catch (e) {
      if (e.status) throw e;
      value = await api(route('/commands/' + command.id + '/receipt'), receipt); // 只重发同一份回执，绝不重复执行
    }
    executed.add(command.id);
    accept(value);
    if (gen !== generation) return;
    for (const a of artifacts) offerFile(a);
    message(command.message, '', (SOURCES[command.source] || '助手') + ' · 已改好');
    progress('');
    bench.afterAgent?.(command);
    void speak(command.id);
  } catch (e) {
    try {
      const value = await api(route());
      accept(value, { render: true });
      if (value.pending.some((c) => c.id === command.id)) accept(await api(route('/commands/' + command.id + '/receipt'), { expected_revision: command.revision, status: 'failed' }));
    } catch { bench.applyState(before); }
    throw e;
  } finally {
    applying = false;
    $('#scene-workbench').classList.remove('remote-applying');
  }
}

function offerFile(a) {
  const href = URL.createObjectURL(a.blob), link = document.createElement('a');
  link.href = href; link.download = a.filename; link.className = 'ai-file';
  link.textContent = '下载 ' + a.filename + ' · ' + Math.ceil(a.bytes / 1024) + ' KB';
  const p = document.createElement('p'); p.className = 'ai-msg'; p.append(link);
  $('#ai-msgs').append(p); $('#ai-log').hidden = false;
  files.push(href);
  while (files.length > 3) URL.revokeObjectURL(files.shift());
}

// ---------- 发送 ----------
async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  bench.prepareForCommand();
  generation++;
  const gen = generation;
  stopAudio();
  player?.unlock();
  setBusy(true);
  message(text, 'user');
  $('#ai-input').value = '';
  try {
    if (!online) { runLocal(text); return; }
    progress('正在理解…');
    network = new AbortController();
    try {
      await inSerial(() => flushSnapshots());
      if (syncError) throw syncError;
      const value = await api(route('/commands'), { text, expected_revision: project.revision, client_request_id: uuid() }, network.signal);
      if (gen !== generation) return;
      accept(value);
      await applyCommand(value.command, gen);
    } catch (e) {
      try { await inSerial(async () => accept(await api(route('/cancel'), {}))); } catch { /* 忽略 */ }
      if (e.name === 'AbortError') return;
      // Agent 未配置或这次没给出可执行的操作：试试本机规则，能理解就照做
      if (e.status === 503 && localPlan(text, bench.getState())) { runLocal(text, '后台 Agent 暂不可用，'); return; }
      message(e.message, 'error');
    }
  } finally {
    network = null;
    progress('');
    setBusy(false);
  }
}

/** 本机规则执行：作为一次手动修改提交（联网时会同步给后台）。 */
function runLocal(text, prefix = '') {
  const doc = bench.getState();
  if (/^(撤销|撤回|回到上一步|撤销上一步)$/.test(text.replace(/[\s。！!]/g, ''))) { bench.undo(); message('已撤销上一步。', '', '本机'); return; }
  if (/^(重做|恢复)$/.test(text.replace(/[\s。！!]/g, ''))) { bench.redo(); message('已恢复。', '', '本机'); return; }
  const plan = localPlan(text, doc);
  if (!plan) {
    message('我还没听懂这个心意。可以说器形（玉壶春、茶碗、陶罐）、形状（爱心、花瓣、方形）、高矮胖瘦、泥料、釉色（天青、粉青、霁蓝…）或纹样（云纹、缠枝莲、海水），也可以点「给我灵感」。', '', '本机演示');
    return;
  }
  try {
    const { doc: next, message: done } = applyLocal(doc, plan.calls);
    bench.commitDocument(next, plan.calls);
    message(prefix + (plan.why ? plan.why + '。' : '') + done, '', '本机规则 · 已改好');
  } catch (e) {
    message('这样改会超出工作台能做的范围，换个小一点的幅度试试。', 'error');
  }
}

// ---------- 本机关键词规则 ----------
const FORM_WORDS = [[/玉壶春/, 'yuhuchun'], [/茶碗|碗/, 'bowl'], [/陶罐|罐/, 'jar'], [/直筒杯|杯/, 'cup'], [/花瓶|花器|瓶子/, 'vase']];
const OUTLINE_WORDS = [[/爱心|心形/, 'heart'], [/三角/, 'triangle'], [/正方|方形|四方/, 'square'], [/长方/, 'rectangle'], [/五边|五角形/, 'pentagon'], [/六边|六角形/, 'hexagon'], [/椭圆/, 'oval'], [/五角星|星形|星星/, 'star'], [/花瓣|葵口|海棠/, 'flower'], [/水滴/, 'teardrop'], [/圆形|变圆|改回圆/, 'circle']];
const PART_WORDS = [[/瓶口|口沿|碗口|杯口|口部/, 'mouth'], [/颈|脖子/, 'neck'], [/肩/, 'shoulder'], [/肚|腹/, 'belly'], [/底部|底足|圈足|底下/, 'base'], [/上半/, 'upper'], [/下半/, 'lower'], [/中间|中段/, 'middle']];
const CLAY_WORDS = [[/赤陶|红陶/, 'terracotta'], [/白瓷泥|瓷泥|白泥|高岭/, 'cream'], [/紫砂/, 'brown'], [/黑陶/, 'charcoal']];
const GLAZE_WORDS = [[/影青|青白/, 'yingqing'], [/天青|雨过天青|淡蓝/, 'tianqing'], [/粉青|翠|玉色/, 'fenqing'], [/豆青|黄绿/, 'douqing'], [/月白/, 'yuebai'], [/甜白|纯白|洁白|白釉/, 'tianbai'], [/霁蓝|宝石蓝|深蓝|蓝釉/, 'jilan'], [/霁红|祭红|红釉|郎窑红/, 'jihong'], [/乌金|黑釉|黑亮/, 'wujin'], [/素烧|不施釉|不上釉|去掉釉/, 'none']];
const PATTERN_WORDS = [[/云纹|祥云|如意云|云头/, 'cloud'], [/缠枝|莲/, 'lotus'], [/海水|浪|波/, 'wave'], [/素面|不要纹|去掉纹|无纹|干净|极简/, 'plain']];
const INK_WORDS = [[/青花|钴蓝|蓝花/, 'cobalt'], [/釉里红|红色纹|红花|朱/, 'copper'], [/描金|金色|金彩/, 'gold'], [/墨彩|水墨|墨色/, 'ink']];
const MOODS = [
  { re: /安静|宁静|清雅|淡雅|文人|禅/, calls: [['set_glaze', { glaze: 'yuebai', pattern: 'plain', gloss: 35 }]], why: '安静的器宜少纹饰，月白润釉更显清雅' },
  { re: /喜庆|热闹|送礼|祝福|新婚|生日/, calls: [['set_glaze', { glaze: 'tianbai', pattern: 'lotus', ink: 'copper' }]], why: '缠枝莲连绵不断，配釉里红更显喜气' },
  { re: /大气|豪迈|壮阔|山河/, calls: [['set_glaze', { pattern: 'wave', ink: 'cobalt', glaze: 'yingqing' }]], why: '海水纹层层推开，气势更开阔' },
  { re: /温柔|可爱|小巧|柔和/, calls: [['set_glaze', { glaze: 'fenqing', gloss: 40 }]], why: '粉青润釉，观感柔和' },
  { re: /古朴|古典|传统/, calls: [['set_base_shape', { shape: 'yuhuchun' }], ['set_glaze', { glaze: 'yingqing', pattern: 'cloud', ink: 'cobalt' }]], why: '玉壶春配青花云纹，最为古朴' },
];
const first = (pairs, text) => pairs.find(([re]) => re.test(text))?.[1];

export function localPlan(text, doc) {
  const t = text.replace(/\s+/g, '');
  const calls = [];
  let why = '';
  const part = first(PART_WORDS, t);
  const form = /做|换|改|来|要|变成|选/.test(t) || t.length <= 4 ? first(FORM_WORDS, t) : null;
  const outline = first(OUTLINE_WORDS, t);
  if (form && !(outline && part)) calls.push(['set_base_shape', { shape: form }]);
  if (outline) calls.push(['set_cross_section', { part: part || 'whole', shape: outline }]);
  const dim = t.match(/(高度?|直径|口径)(?:改成|改为|调到|设为|设成|做成)?(\d+(?:\.\d+)?)(?:厘米|公分|cm)/i);
  if (dim) calls.push(['set_dimensions', dim[1] === '直径' || dim[1] === '口径' ? { diameter_cm: +dim[2] } : { height_cm: Math.min(40, Math.max(8, +dim[2])) }]);
  else if (/高一点|高些|拉高|更高|修长|高挑/.test(t)) calls.push(['set_dimensions', { height_cm: Math.min(40, doc.height * 1.15) }]);
  else if (/矮一点|矮些|压低|更矮|矮胖|小巧/.test(t)) calls.push(['set_dimensions', { height_cm: Math.max(8, doc.height * 0.87) }]);
  const much = /明显|很多|大一点|多一点/.test(t) ? 18 : 10;
  if (/胖|鼓|宽|粗|丰满|饱满|放大|撑开|张开/.test(t)) calls.push(['reshape_region', { part: part || 'whole', radius_scale_percent: much, side: 'all' }]);
  else if (/瘦|窄|细|收|缩小|苗条/.test(t)) calls.push(['reshape_region', { part: part || 'whole', radius_scale_percent: -much, side: 'all' }]);
  if (/抚平|磨平|光滑|平滑/.test(t)) calls.push(['smooth_surface', { part: part || 'whole', strength: 0.6 }]);
  const clay = first(CLAY_WORDS, t);
  if (clay) calls.push(['set_material', { material: clay }]);
  const glaze = {};
  const g = first(GLAZE_WORDS, t), p = first(PATTERN_WORDS, t), ink = first(INK_WORDS, t);
  if (g) glaze.glaze = g;
  if (p) glaze.pattern = p;
  if (ink) { glaze.ink = ink; if (!p && doc.pattern === 'plain') glaze.pattern = 'cloud'; }
  if (/开片|冰裂|裂纹/.test(t)) glaze.crackle = !/不要|去掉|不开/.test(t);
  if (/亮釉|光亮|透亮|亮一点|玻璃/.test(t)) glaze.gloss = 88;
  else if (/哑光|温润|内敛|润一点|柔光/.test(t)) glaze.gloss = 30;
  if ((glaze.pattern && glaze.pattern !== 'plain' || glaze.crackle) && !g && doc.glaze === 'none') glaze.glaze = 'tianbai';
  if (Object.keys(glaze).length) calls.push(['set_glaze', glaze]);
  if (/俯视|从上面看|看看口/.test(t)) calls.push(['set_view', { direction: 'top' }]);
  else if (/正面看|从正面/.test(t)) calls.push(['set_view', { direction: 'front' }]);
  if (/停|暂停/.test(t) && /转/.test(t)) calls.push(['set_wheel', { rotating: false }]);
  else if (/转起来|启动转盘|继续转/.test(t)) calls.push(['set_wheel', { rotating: true }]);
  if (!calls.length) {
    const mood = MOODS.find((m) => m.re.test(t));
    if (mood) { calls.push(...mood.calls); why = mood.why; }
  }
  if (!calls.length) return null;
  return { calls: calls.map(([tool, args]) => ({ tool, arguments: args })), why };
}

const INSPIRE = [
  { calls: [['set_base_shape', { shape: 'yuhuchun' }], ['set_glaze', { glaze: 'yingqing', pattern: 'cloud', ink: 'cobalt', crackle: false, gloss: 75 }]], why: '玉壶春配青花云纹，如意云头绕器一周' },
  { calls: [['set_base_shape', { shape: 'vase' }], ['set_glaze', { glaze: 'tianqing', pattern: 'plain', gloss: 40 }]], why: '花器施天青润釉，素面不着一笔，像雨后一片天色' },
  { calls: [['set_base_shape', { shape: 'jar' }], ['set_glaze', { glaze: 'tianbai', pattern: 'lotus', ink: 'cobalt', gloss: 80 }]], why: '圆腹宜绕一周缠枝莲，白地青花最清朗' },
  { calls: [['set_base_shape', { shape: 'bowl' }], ['set_cross_section', { part: 'whole', shape: 'flower', lobes: 6 }], ['set_glaze', { glaze: 'fenqing', pattern: 'plain', crackle: true, gloss: 55 }]], why: '六瓣葵口茶碗，粉青开片，温润里有一点碎光' },
  { calls: [['set_base_shape', { shape: 'yuhuchun' }], ['set_glaze', { glaze: 'jilan', pattern: 'cloud', ink: 'gold', gloss: 85 }]], why: '霁蓝地上描金云纹，沉静中见华彩' },
  { calls: [['set_base_shape', { shape: 'cup' }], ['set_material', { material: 'brown' }], ['set_glaze', { glaze: 'none', pattern: 'plain', gloss: 18 }]], why: '紫砂直筒杯素烧不施釉，留住泥的本色与拉坯痕' },
  { calls: [['set_base_shape', { shape: 'vase' }], ['set_glaze', { glaze: 'yuebai', pattern: 'wave', ink: 'copper', gloss: 70 }]], why: '月白地上一圈釉里红海水，素净里见心意' },
];
let lastInspire = -1;

function inspire() {
  if (busy) return;
  let i;
  do { i = (Math.random() * INSPIRE.length) | 0; } while (i === lastInspire);
  lastInspire = i;
  const s = INSPIRE[i];
  try {
    const calls = s.calls.map(([tool, args]) => ({ tool, arguments: args }));
    const { doc } = applyLocal(bench.getState(), calls);
    bench.commitDocument(doc, calls);
    message(`试试这一组：${s.why}。不喜欢可以撤销。`, '', '灵感');
  } catch { message('这组搭配放不进当前尺寸，再点一次换一组。', 'error'); }
}

// ---------- 朗读 ----------
function stopAudio() {
  audioNetwork?.abort();
  audioNetwork = null;
  player?.reset();
  if (!busy) $('#ai-stop').hidden = true;
}
const readAloud = () => $('#ai-read').getAttribute('aria-pressed') === 'true' && !app.muted;

async function speak(commandId) {
  if (!readAloud() || !online) return;
  stopAudio();
  const controller = new AbortController();
  audioNetwork = controller;
  $('#ai-stop').hidden = false;
  try {
    const res = await fetch(API + route('/speech'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': credentials.token },
      body: JSON.stringify({ command_id: commandId }), signal: controller.signal,
    });
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw Error(body.error?.message || '声音生成失败'); }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1], raw = frame.match(/^data: (.+)$/m)?.[1];
        if (!raw) continue;
        const packet = JSON.parse(raw);
        if (event === 'audio_chunk') player.append(packet);
        if (event === 'voice_done') player.finish();
        if (event === 'speech_error') throw Error(packet.message);
      }
      if (done) break;
    }
  } catch (e) {
    if (e.name !== 'AbortError') progress('声音没有播出来：' + e.message);
  } finally {
    if (audioNetwork === controller) audioNetwork = null;
    if (!busy && !player.sources.size) $('#ai-stop').hidden = true;
  }
}

// ---------- 按住说话 ----------
let held = false, recording = null;

function wav(parts, total) {
  const bytes = new ArrayBuffer(44 + total * 2), v = new DataView(bytes);
  const word = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  word(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); word(8, 'WAVE'); word(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); word(36, 'data'); v.setUint32(40, total * 2, true);
  let at = 44;
  for (const part of parts) for (const s of part) { const x = Math.max(-1, Math.min(1, s)); v.setInt16(at, x < 0 ? x * 32768 : x * 32767, true); at += 2; }
  return new Blob([bytes], { type: 'audio/wav' });
}

async function beginRecording() {
  if (busy || recording || !online || !project) return;
  held = true;
  bench.pauseForVoice();
  setBusy(true);
  stopAudio();
  player.unlock();
  progress('正在准备麦克风…');
  let context, stream, node;
  try {
    context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (!held) { stream.getTracks().forEach((t) => t.stop()); await context.close(); setBusy(false); progress(''); return; }
    if (context.sampleRate !== 16000) throw Error('浏览器不支持这种录音格式，请使用新版 Chrome。');
    await context.audioWorklet.addModule(new URL('./voice/recording-worklet.js', import.meta.url));
    if (!held) { stream.getTracks().forEach((t) => t.stop()); await context.close(); setBusy(false); progress(''); return; }
    const source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'heritage-recorder');
    const active = { context, stream, node, source, parts: [], total: 0 };
    recording = active;
    node.port.onmessage = (event) => {
      if (recording !== active) return;
      if (event.data.flushed) { active.flush?.(); return; }
      const part = event.data.subarray(0, 480000 - active.total);
      active.parts.push(part);
      active.total += part.length;
      progress('正在听 · ' + (active.total / 16000).toFixed(1) + ' 秒');
      if (active.total >= 480000) void endRecording(true);
    };
    source.connect(node);
    node.connect(context.destination);
    $('#ai-mic').classList.add('recording');
    $('#ai-mic').disabled = false;
  } catch (e) {
    held = false;
    stream?.getTracks().forEach((t) => t.stop());
    node?.disconnect();
    await context?.close().catch(() => {});
    recording = null;
    setBusy(false);
    progress(e.name === 'NotAllowedError' ? '麦克风权限没有开启。' : e.message);
  }
}

async function endRecording(sendNow) {
  held = false;
  const active = recording;
  if (!active) return;
  if (!sendNow) active.cancelled = true;
  if (active.finishing) return;
  active.finishing = true;
  await new Promise((resolve) => { active.flush = resolve; active.node.port.postMessage('flush'); setTimeout(resolve, 150); });
  recording = null;
  active.node.port.onmessage = null;
  active.source.disconnect();
  active.node.disconnect();
  active.stream.getTracks().forEach((t) => t.stop());
  await active.context.close().catch(() => {});
  $('#ai-mic').classList.remove('recording');
  if (!sendNow || active.cancelled || active.total < 3200) {
    setBusy(false);
    progress(active.total < 3200 ? '说得太短了，请按住再说一次。' : '');
    return;
  }
  const controller = new AbortController();
  recognition = controller;
  progress('正在识别…');
  try {
    const res = await fetch(API + '/sessions/' + project.session_id + '/transcribe', {
      method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Session-Token': credentials.token },
      body: wav(active.parts, active.total), signal: controller.signal,
    });
    const body = await res.json();
    if (!res.ok) throw Error(body.error?.message || '语音识别失败');
    const text = body.data.text;
    if (!text?.trim()) throw Error('没有听清，请再说一次。');
    setBusy(false);
    await send(text);
  } catch (e) {
    if (e.name !== 'AbortError') { message(e.message, 'error'); progress(''); }
  } finally {
    recognition = null;
    setBusy(false);
  }
}

// ---------- 轮询：通过接口发来的工具调用，也由当前打开的工作台执行 ----------
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (closed || busy || syncing || snapshots.length || !project || bench.isEditing() || app.scene !== 'workbench') return;
    void inSerial(async () => {
      if (busy || snapshots.length) return;
      const value = await api(route());
      if (value.project.revision !== project.revision) accept(value);
      if (value.pending.length) {
        setBusy(true);
        try { await applyCommand(value.pending[0], generation); } finally { setBusy(false); }
      }
    }).catch((e) => {
      if (e.status === 410) { project = null; online = false; setBusy(false); status('会话已过期 · 本机演示', 'off'); }
    });
  }, 2000);
}

export const agent = {
  get online() { return online && !!project; },
  /** 后台撤销 / 重做（联网时以后台历史为准）。 */
  command(text) { if (busy) { progress('上一条还在处理，可以先点停止。'); return; } void send(text); },
  init(a, b) {
    app = a;
    bench = b;
    player = new PCMPlayer({
      onStart() { progress('正在朗读…'); },
      onFinish() { if (!busy) progress(''); if (!busy && !audioNetwork) $('#ai-stop').hidden = true; },
      onBlocked() { progress('点一下页面即可播放声音。'); },
    });
    bench.subscribe(onManualChange);
    $('#ai-form').addEventListener('submit', (e) => { e.preventDefault(); void send($('#ai-input').value); });
    $('#ai-inspire').addEventListener('click', inspire);
    $('#ai-read').addEventListener('click', () => {
      const on = $('#ai-read').getAttribute('aria-pressed') !== 'true';
      $('#ai-read').setAttribute('aria-pressed', String(on));
      if (!on) stopAudio(); else player.resume();
    });
    $('#ai-stop').addEventListener('click', () => {
      generation++;
      network?.abort();
      recognition?.abort();
      held = false;
      void endRecording(false);
      stopAudio();
      progress('已停止。');
      if (project) void inSerial(async () => accept(await api(route('/cancel'), {}))).catch(() => {});
    });
    $('#ai-log-close').addEventListener('click', () => { $('#ai-log').hidden = true; });
    const mic = $('#ai-mic');
    mic.addEventListener('pointerdown', (e) => { e.preventDefault(); if (busy) return; mic.setPointerCapture(e.pointerId); void beginRecording(); });
    mic.addEventListener('pointerup', () => void endRecording(true));
    mic.addEventListener('pointercancel', () => void endRecording(false));
    mic.addEventListener('keydown', (e) => { if (['Space', 'Enter'].includes(e.code) && !e.repeat) { e.preventDefault(); void beginRecording(); } });
    mic.addEventListener('keyup', (e) => { if (['Space', 'Enter'].includes(e.code)) { e.preventDefault(); void endRecording(true); } });
    // 执行 Agent 指令期间，键盘快捷键不打断它
    document.addEventListener('keydown', (e) => {
      if ($('#scene-workbench').classList.contains('remote-applying') && !e.target.closest('#wb-ai')) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    window.addEventListener('pagehide', () => {
      closed = true;
      network?.abort();
      recognition?.abort();
      void endRecording(false);
      stopAudio();
      player.destroy();
      files.forEach((h) => URL.revokeObjectURL(h));
    });
    return connect();
  },
  stopVoice() { stopAudio(); },
};
