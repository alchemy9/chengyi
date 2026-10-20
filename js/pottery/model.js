// 作品文档：器形、泥料、釉、横向形状、局部塑形、转盘与视角。字段与后端 server/app/workbench_schemas.py 的 Document 一致，
// 联网时整份同步给后台，Agent 在后台算出新文档、网页执行后回执。离线时 applyLocal 按同样的规则在本机修改。
import * as G from './geometry.js';

export const N = 96;
export const STAGE_POLAR_DEG = 83.82; // 主镜头俯角约 6°，与后端一致

/** 器形起点（练泥）：四种基础形 + 青瓷云纹瓶原器的轮廓。 */
export const FORMS = [
  { id: 'yuhuchun', name: '玉壶春', note: '青瓷云纹瓶原器的轮廓', height: 30 },
  { id: 'vase', name: '花器', note: '肩丰腹敛，口微撇', height: 28 },
  { id: 'jar', name: '陶罐', note: '腹圆口敞，敦实', height: 23 },
  { id: 'bowl', name: '茶碗', note: '口阔足小，宜手握', height: 12 },
  { id: 'cup', name: '直筒杯', note: '上下几近等宽', height: 22 },
];

/** 泥料（择土）。celadon、blue 只用于读取旧作品。 */
export const CLAYS = [
  { id: 'terracotta', name: '赤陶泥', color: '#a8694b', gloss: 25, note: '含铁较多，烧后红褐，质朴温厚' },
  { id: 'cream', name: '白瓷泥', color: '#e4dacb', gloss: 40, note: '细腻洁白，最能衬出釉色' },
  { id: 'brown', name: '紫砂泥', color: '#6d4838', gloss: 12, note: '砂感细密，宜素面不施釉' },
  { id: 'charcoal', name: '黑陶泥', color: '#3b3936', gloss: 30, note: '色深如墨，打磨后见温润光泽' },
];
const LEGACY_CLAYS = { celadon: { name: '青瓷釉', color: '#8fa69a', gloss: 72 }, blue: { name: '天青釉', color: '#64808e', gloss: 75 } };

/** 釉色（施釉）。rgb 为烧成后的预览色。 */
export const GLAZES = [
  { id: 'none', name: '素烧', note: '不施釉，保留泥色与拉坯痕' },
  { id: 'yingqing', name: '影青', rgb: [205, 224, 220], note: '青白相间，薄处见白' },
  { id: 'tianqing', name: '天青', rgb: [178, 204, 212], note: '淡青微蓝' },
  { id: 'fenqing', name: '粉青', rgb: [163, 197, 178], note: '青中泛绿，温润如玉' },
  { id: 'douqing', name: '豆青', rgb: [176, 190, 148], note: '青黄相和' },
  { id: 'yuebai', name: '月白', rgb: [222, 228, 226], note: '白中闪青' },
  { id: 'tianbai', name: '甜白', rgb: [238, 234, 222], note: '洁白温润' },
  { id: 'jilan', name: '霁蓝', rgb: [36, 62, 118], note: '蓝如深海，沉静' },
  { id: 'jihong', name: '霁红', rgb: [142, 36, 32], note: '红而不艳，凝厚' },
  { id: 'wujin', name: '乌金', rgb: [30, 28, 27], note: '黑亮如漆' },
];

export const PATTERNS = [
  { id: 'plain', name: '素面', note: '不加纹饰，只见釉色' },
  { id: 'cloud', name: '云纹', note: '如意云头，绕器一周' },
  { id: 'lotus', name: '缠枝莲', note: '连绵花叶绕腹一周' },
  { id: 'wave', name: '海水', note: '下腹层叠浪纹' },
];

export const INKS = [
  { id: 'cobalt', name: '青花', rgb: [38, 74, 140] },
  { id: 'copper', name: '釉里红', rgb: [146, 52, 44] },
  { id: 'gold', name: '描金', rgb: [184, 142, 72] },
  { id: 'ink', name: '墨彩', rgb: [44, 50, 56] },
];

/** 塑形部位：高度比例区间，与后端 PARTS 一致。 */
export const PARTS = {
  whole: [0, 1], mouth: [0.88, 1], neck: [0.68, 0.9], shoulder: [0.5, 0.72], belly: [0.22, 0.58],
  base: [0, 0.18], upper: [0.5, 1], middle: [0.33, 0.67], lower: [0, 0.5],
};
export const PART_NAMES = { whole: '整体', mouth: '口沿', neck: '颈部', shoulder: '肩部', belly: '腹部', base: '底部', upper: '上半部', middle: '中段', lower: '下半部' };

const YUHUCHUN = [0.7, 0.746, 0.816, 0.839, 0.834, 0.816, 0.804, 0.828, 0.888, 0.952, 1.013, 1.075, 1.138, 1.198, 1.247, 1.281, 1.312, 1.354, 1.397, 1.437, 1.474, 1.509, 1.537, 1.556, 1.574, 1.597, 1.621, 1.642, 1.661, 1.677, 1.69, 1.699, 1.705, 1.709, 1.714, 1.718, 1.72, 1.72, 1.719, 1.716, 1.712, 1.707, 1.696, 1.68, 1.659, 1.634, 1.604, 1.57, 1.538, 1.513, 1.486, 1.443, 1.387, 1.325, 1.258, 1.187, 1.123, 1.075, 1.027, 0.957, 0.878, 0.807, 0.748, 0.698, 0.659, 0.635, 0.613, 0.586, 0.559, 0.537, 0.52, 0.503, 0.486, 0.472, 0.463, 0.455, 0.445, 0.437, 0.433, 0.434, 0.438, 0.443, 0.445, 0.448, 0.453, 0.464, 0.484, 0.508, 0.532, 0.553, 0.58, 0.629, 0.697, 0.756, 0.775, 0.763];

export const byId = (list, id) => list.find((x) => x.id === id);
export const clayOf = (id) => byId(CLAYS, id) || LEGACY_CLAYS[id] || CLAYS[0];
export const formHeight = (id) => byId(FORMS, id).height;

export function makeProfile(preset) {
  if (preset === 'yuhuchun') return YUHUCHUN.slice();
  return Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    if (preset === 'jar') return 1.04 + 0.77 * Math.pow(Math.sin(t * Math.PI), 0.75) - 0.13 * t;
    if (preset === 'bowl') return 0.72 + 1.57 * Math.sin(t * Math.PI * 0.46);
    if (preset === 'cup') return 1.03 + 0.16 * t;
    return 0.85 + 0.67 * Math.exp(-Math.pow((t - 0.31) / 0.29, 2)) - 0.27 * Math.exp(-Math.pow((t - 0.82) / 0.18, 2)) + 0.1 * t;
  });
}

export const VIEWS = {
  front: { azimuth_deg: 0, polar_deg: STAGE_POLAR_DEG },
  perspective: { azimuth_deg: 0, polar_deg: STAGE_POLAR_DEG },
  top: { azimuth_deg: 0, polar_deg: (0.025 * 180) / Math.PI },
};

export function newDocument(preset = 'yuhuchun') {
  return {
    name: '未命名的器', profile: makeProfile(preset), height: formHeight(preset), material: 'cream', gloss: 40, preset,
    glaze: 'none', pattern: 'plain', ink: 'cobalt', crackle: false,
    ...G.extraState({}),
    wheel: { rotating: true, speed_rpm: 12, rotation_deg: 0 },
    view: { direction: 'perspective', ...VIEWS.perspective, zoom_percent: 100 },
  };
}

const finite = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

/** 校验并补齐一份文档；不合格时抛错。用于读取草稿、打开工程文件、接收后台文档。 */
export function validate(data) {
  if (!data || !Array.isArray(data.profile) || data.profile.length !== N || !data.profile.every((v) => finite(v, 0.32, 2.9))
    || !finite(data.height, 8, 40) || !(byId(CLAYS, data.material) || LEGACY_CLAYS[data.material]) || !finite(data.gloss, 0, 100)
    || !byId(FORMS, data.preset)) throw Error('工程文件格式不正确');
  const glaze = data.glaze ?? 'none', pattern = data.pattern ?? 'plain', ink = data.ink ?? 'cobalt', crackle = data.crackle ?? false;
  if (!byId(GLAZES, glaze) || !byId(PATTERNS, pattern) || !byId(INKS, ink) || typeof crackle !== 'boolean') throw Error('釉色或纹样参数不正确');
  const base = newDocument(data.preset);
  const wheel = { ...base.wheel, ...data.wheel }, view = { ...base.view, ...data.view };
  if (typeof wheel.rotating !== 'boolean' || !finite(wheel.speed_rpm, 5, 60) || !finite(wheel.rotation_deg, -180, 180)
    || !['front', 'top', 'perspective', 'custom'].includes(view.direction) || !finite(view.azimuth_deg, -360, 360)
    || !finite(view.polar_deg, 1.43, 88) || !finite(view.zoom_percent, 57, 190)) throw Error('转盘或视角参数不正确');
  const doc = {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.slice(0, 40) : base.name,
    profile: [...data.profile], height: data.height, material: data.material, gloss: data.gloss, preset: data.preset,
    glaze, pattern, ink, crackle, ...G.extraState(data), wheel, view,
  };
  const st = G.stats(doc);
  if (st.min_radius < 0.14 - 1e-8 || st.max_radius > 2.9 + 1e-8) throw Error('局部轮廓过薄或超出工作台范围');
  return doc;
}

export const clone = (v) => JSON.parse(JSON.stringify(v));

export function measure(doc, rows) {
  const st = G.stats(doc, rows);
  return { height: doc.height, diameter: st.diameter_cm, mouth: st.mouth_diameter_cm };
}

/** 一句话概括，用于分享图与文案。 */
export function summary(doc) {
  const form = byId(FORMS, doc.preset).name, clay = clayOf(doc.material).name;
  const g = byId(GLAZES, doc.glaze);
  const parts = [form + (doc.cross_section.shape === 'circle' ? '' : '·' + G.NAMES[doc.cross_section.shape].replace('形', ''))];
  parts.push(doc.glaze === 'none' ? clay + '素烧' : g.name + (doc.gloss < 45 ? '润釉' : '亮釉') + (doc.crackle ? '开片' : ''));
  if (doc.pattern !== 'plain') parts.push(byId(INKS, doc.ink).name + byId(PATTERNS, doc.pattern).name);
  return parts.join(' · ');
}

export function suggestName(doc) {
  const g = byId(GLAZES, doc.glaze), p = doc.pattern;
  const head = doc.glaze === 'none' ? clayOf(doc.material).name.replace('泥', '') : g.name;
  const mid = { plain: '素', cloud: '云纹', lotus: '缠枝莲纹', wave: '海水纹' }[p];
  return `${head}${mid}${byId(FORMS, doc.preset).name.replace('直筒杯', '杯').replace('花器', '瓶').replace('玉壶春', '玉壶春瓶')}`.replace('素茶碗', '素碗');
}

// ---------- 本机执行工具（离线时使用，规则与后端 pottery.apply_batch 一致） ----------

function region(args) {
  if (args.start_height_ratio != null) return [args.start_height_ratio, args.end_height_ratio];
  return PARTS[args.part || 'whole'];
}
function sideAngle(doc, side) {
  const angle = doc.view.azimuth_deg - (doc.wheel.rotation_deg || 0);
  return ((angle + { front: 0, back: 180, left: -90, right: 90 }[side] + 180) % 360 + 360) % 360 - 180;
}

/** 执行一组工具调用，返回 { doc, message }；超出范围时抛错且不修改原文档。 */
export function applyLocal(input, calls) {
  let doc = clone(input);
  const messages = [];
  for (const { tool, arguments: args = {} } of calls) {
    if (tool === 'set_base_shape') {
      Object.assign(doc, { preset: args.shape, profile: makeProfile(args.shape), height: formHeight(args.shape), ...G.extraState({}) });
      messages.push('已换成' + byId(FORMS, args.shape).name + '的坯形。');
    } else if (tool === 'set_dimensions') {
      if (args.height_cm != null) doc.height = args.height_cm;
      if (args.diameter_cm != null) {
        const ratio = args.diameter_cm / G.stats(doc).diameter_cm;
        doc.profile = doc.profile.map((r) => r * ratio);
        doc.deformations.forEach((d) => { d.radius_delta_cm *= ratio; });
      }
      const m = measure(doc);
      messages.push(`高 ${m.height.toFixed(1)} 厘米，最大径 ${m.diameter.toFixed(1)} 厘米。`);
    } else if (tool === 'reshape_region') {
      const [start, end] = region(args);
      let center = args.angle_deg;
      if (center == null && args.side && args.side !== 'all') center = sideAngle(doc, args.side);
      if (center == null) {
        doc.profile = doc.profile.map((r, i) => r + ((args.radius_delta_cm || 0) / 6 + r * (args.radius_scale_percent || 0) / 100) * G.regionWeight(i / (N - 1), start, end));
      } else {
        doc.deformations.push({ start_height_ratio: start, end_height_ratio: end, angle_deg: center, angular_width_deg: args.angular_width_deg ?? 90, radius_delta_cm: args.radius_delta_cm || 0, radius_scale_percent: args.radius_scale_percent || 0 });
        doc.wheel.rotating = false;
      }
      messages.push((PART_NAMES[args.part] || '指定区域') + '已调整。');
    } else if (tool === 'set_cross_section') {
      const [start, end] = region(args);
      const whole = start === 0 && end === 1;
      const current = whole ? doc.cross_section : ([...doc.section_bands].reverse().find((b) => b.start_height_ratio === start && b.end_height_ratio === end) || doc.cross_section);
      const sec = { ...current };
      delete sec.start_height_ratio; delete sec.end_height_ratio;
      if (args.shape && args.shape !== sec.shape) Object.assign(sec, { points: [], aspect_ratio: ['oval', 'rectangle'].includes(args.shape) ? 1.5 : 1 });
      for (const k of ['shape', 'roundness', 'rotation_deg', 'aspect_ratio', 'lobes', 'points']) if (args[k] != null) sec[k] = args[k];
      const valid = G.section(sec);
      if (whole) {
        doc.cross_section = valid;
        if (args.shape) { doc.section_bands = []; doc.wheel.rotation_deg = 0; }
      } else {
        doc.section_bands = doc.section_bands.filter((b) => !(b.start_height_ratio === start && b.end_height_ratio === end));
        doc.section_bands.push({ ...valid, start_height_ratio: start, end_height_ratio: end });
      }
      doc.wheel.rotating = false;
      if (args.shape) doc.view = { ...doc.view, direction: 'top', ...VIEWS.top };
      messages.push((whole ? '整体' : PART_NAMES[args.part] || '指定部位') + '从上面看已是' + G.NAMES[valid.shape] + '。');
    } else if (tool === 'set_material') {
      if (args.material) {
        const legacy = { celadon: 'fenqing', blue: 'tianqing' }[args.material];
        doc.gloss = clayOf(args.material).gloss;
        if (legacy) { doc.material = 'cream'; doc.glaze = legacy; } else doc.material = args.material;
      }
      if (args.gloss != null) doc.gloss = args.gloss;
      messages.push('已选用' + clayOf(doc.material).name + '。');
    } else if (tool === 'set_glaze') {
      for (const k of ['glaze', 'pattern', 'ink', 'crackle', 'gloss']) if (args[k] != null) doc[k] = args[k];
      if (args.glaze != null && args.gloss == null) doc.gloss = args.glaze === 'none' ? 20 : 70;
      if (doc.glaze === 'none') doc.crackle = false;
      messages.push(doc.glaze === 'none' ? '已改为素烧。' : '已施' + byId(GLAZES, doc.glaze).name + '釉' + (doc.pattern === 'plain' ? '，素面。' : '，绘' + byId(INKS, doc.ink).name + byId(PATTERNS, doc.pattern).name + '。'));
    } else if (tool === 'set_wheel') {
      Object.assign(doc.wheel, args);
      messages.push(doc.wheel.rotating ? '转盘已启动。' : '转盘已停下。');
    } else if (tool === 'set_view') {
      if (args.direction) doc.view = { ...doc.view, direction: args.direction, ...VIEWS[args.direction] };
      if (args.zoom_percent != null) doc.view.zoom_percent = args.zoom_percent;
      messages.push('视角已调整。');
    } else if (tool === 'smooth_surface') {
      const [s0, s1] = region(args);
      for (let pass = 0; pass < (args.passes || 2); pass++) {
        const orig = doc.profile.slice();
        doc.profile = orig.map((r, i) => {
          const a = Math.max(0, i - 3), b = Math.min(N, i + 4), avg = orig.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
          return r + (avg - r) * (args.strength ?? 0.5) * G.regionWeight(i / (N - 1), s0, s1);
        });
      }
      messages.push('已抚平。');
    }
  }
  return { doc: validate(doc), message: messages.join('') };
}
