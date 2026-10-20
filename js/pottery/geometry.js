// 陶坯几何：96 层竖向轮廓 × 128 段横向轮廓。与后端 server/app/pottery_geometry.py 一一对应，
// 后端校验尺寸、Agent 计算修改，网页按同一套规则生成三维网格。单位：1 = 6 厘米。
export const SEGMENTS = 128;
export const ROWS = 96;
const TAU = Math.PI * 2;
const cache = new Map();

export const NAMES = { circle: '圆形', heart: '爱心形', triangle: '三角形', square: '正方形', rectangle: '长方形', pentagon: '五边形', hexagon: '六边形', oval: '椭圆形', star: '星形', flower: '花瓣形', teardrop: '水滴形', custom: '自定义轮廓' };
export const defaults = () => ({ shape: 'circle', roundness: 0.2, rotation_deg: 0, aspect_ratio: 1, lobes: 5, points: [] });

function number(value, low, high) {
  if (!Number.isFinite(value) || value < low || value > high) throw Error('轮廓参数超出工作台支持范围');
  return value;
}

export function section(data = {}) {
  const s = { ...defaults(), ...data };
  if (!Object.hasOwn(NAMES, s.shape)) throw Error('无法识别这种轮廓');
  number(s.roundness, 0, 1); number(s.rotation_deg, -180, 180); number(s.aspect_ratio, 0.4, 2.5); number(s.lobes, 3, 8);
  if (!Number.isInteger(s.lobes) || !Array.isArray(s.points) || s.points.length > 32) throw Error('轮廓参数不正确');
  s.points = s.points.map((p) => ({ angle_deg: number(p.angle_deg, 0, 359.999999), radius_ratio: number(p.radius_ratio, 0.2, 1) }));
  if (s.shape === 'custom' ? (s.points.length < 3 || s.points.some((p, i) => i && p.angle_deg <= s.points[i - 1].angle_deg)) : s.points.length) throw Error('自定义轮廓控制点不正确');
  return s;
}

export function extraState(data) {
  const bands = data.section_bands || [], details = data.deformations || [];
  if (!Array.isArray(bands) || bands.length > 8 || !Array.isArray(details) || details.length > 32) throw Error('局部塑形数量超出范围');
  const checkRegion = (s) => {
    number(s.start_height_ratio, 0, 1); number(s.end_height_ratio, 0, 1);
    if (s.start_height_ratio >= s.end_height_ratio) throw Error('塑形区域不正确');
    return s;
  };
  return {
    cross_section: section(data.cross_section),
    section_bands: bands.map((b) => checkRegion({ ...section(b), start_height_ratio: b.start_height_ratio, end_height_ratio: b.end_height_ratio })),
    deformations: details.map((d) => checkRegion({
      start_height_ratio: d.start_height_ratio, end_height_ratio: d.end_height_ratio,
      angle_deg: number(d.angle_deg, -180, 180), angular_width_deg: number(d.angular_width_deg ?? 90, 10, 360),
      radius_delta_cm: number(d.radius_delta_cm ?? 0, -6, 6), radius_scale_percent: number(d.radius_scale_percent ?? 0, -60, 100),
    })),
  };
}

export function regionWeight(t, start, end) {
  if (t < start || t > end) return 0;
  const edge = Math.min(0.08, (end - start) / 3);
  let w = 1;
  if (start > 0) w = Math.min(w, Math.min(1, (t - start) / edge));
  if (end < 1) w = Math.min(w, Math.min(1, (end - t) / edge));
  return 0.5 - 0.5 * Math.cos(Math.PI * w);
}

export function angularWeight(angle, center, width) {
  if (width >= 360) return 1;
  const d = Math.abs(((angle - center + 180) % 360 + 360) % 360 - 180);
  return d < width / 2 ? 0.5 + 0.5 * Math.cos(Math.PI * d / (width / 2)) : 0;
}

function path(shape) {
  const points = [];
  for (let i = 0; i < 512; i++) {
    const t = i * TAU / 512;
    points.push(shape === 'heart'
      ? [16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]
      : [Math.sin(t) * (0.7 + 0.3 * Math.cos(t)), -Math.cos(t)]);
  }
  const scale = Math.max(...points.map(([x, z]) => Math.hypot(x, z)));
  return points.map(([x, z]) => [x / scale, z / scale]);
}

function ray(points, angle) {
  const dx = Math.sin(angle), dz = Math.cos(angle);
  let radius = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, az] = points[i], [bx, bz] = points[(i + 1) % points.length], vx = bx - ax, vz = bz - az, den = dx * vz - dz * vx;
    if (Math.abs(den) < 1e-12) continue;
    const r = (ax * vz - az * vx) / den, u = (ax * dz - az * dx) / den;
    if (r > 0 && u >= -1e-9 && u <= 1 + 1e-9) radius = Math.max(radius, r);
  }
  return radius;
}

export function lookup(values, angle) {
  const at = (((angle % TAU) + TAU) % TAU) / TAU * SEGMENTS, first = Math.floor(at) % SEGMENTS, u = at - Math.floor(at);
  return values[first] * (1 - u) + values[(first + 1) % SEGMENTS] * u;
}

export function sectionRadii(s) {
  const key = JSON.stringify(s);
  if (cache.has(key)) return cache.get(key);
  const shape = s.shape || 'circle', lobes = s.lobes || 5, outline = ['heart', 'teardrop'].includes(shape) ? path(shape) : null;
  let values = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const angle = i * TAU / SEGMENTS;
    let r = 1;
    if (outline) r = ray(outline, angle);
    else if (['triangle', 'square', 'rectangle', 'pentagon', 'hexagon'].includes(shape)) {
      const sides = { triangle: 3, square: 4, rectangle: 4, pentagon: 5, hexagon: 6 }[shape], half = Math.PI / sides, phase = sides === 4 ? Math.PI / 4 : Math.PI;
      const relative = ((angle - phase) % (2 * half) + 2 * half) % (2 * half) - half;
      r = Math.cos(half) / Math.cos(relative);
    } else if (shape === 'star') {
      const vertices = Array.from({ length: lobes * 2 }, (_, j) => [Math.sin(Math.PI + j * Math.PI / lobes) * (j % 2 ? 0.48 : 1), Math.cos(Math.PI + j * Math.PI / lobes) * (j % 2 ? 0.48 : 1)]);
      r = ray(vertices, angle);
    } else if (shape === 'flower') r = 0.82 + 0.18 * Math.cos(lobes * (angle - Math.PI));
    else if (shape === 'custom') {
      const points = s.points, ext = [{ ...points[points.length - 1], angle_deg: points[points.length - 1].angle_deg - 360 }, ...points, { ...points[0], angle_deg: points[0].angle_deg + 360 }], deg = i * 360 / SEGMENTS;
      for (let j = 0; j < ext.length - 1; j++) {
        const a = ext[j], b = ext[j + 1];
        if (a.angle_deg <= deg && deg <= b.angle_deg) { const u = (deg - a.angle_deg) / (b.angle_deg - a.angle_deg); r = a.radius_ratio * (1 - u) + b.radius_ratio * u; break; }
      }
    }
    values.push(r);
  }
  const width = Math.ceil((s.roundness ?? 0.2) * 8);
  if (width) {
    const sigma = Math.max(0.6, width * 0.55), weights = Array.from({ length: width * 2 + 1 }, (_, i) => Math.exp(-((i - width) ** 2) / (2 * sigma * sigma))), total = weights.reduce((a, b) => a + b, 0);
    values = values.map((_, i) => weights.reduce((sum, w, k) => sum + values[(i + k - width + SEGMENTS) % SEGMENTS] * w, 0) / total);
  }
  const max = Math.max(...values);
  values = values.map((v) => v / max);
  const aspect = s.aspect_ratio ?? 1, sx = Math.min(1, aspect), sz = Math.min(1, 1 / aspect), rotation = (s.rotation_deg || 0) * Math.PI / 180;
  const result = Array.from({ length: SEGMENTS }, (_, i) => {
    const a = i * TAU / SEGMENTS - rotation, ux = Math.sin(a) / sx, uz = Math.cos(a) / sz;
    return lookup(values, Math.atan2(ux, uz)) / Math.hypot(ux, uz);
  });
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

/** 每层每段的实际半径：竖向轮廓 × 横向形状，再叠加部位形状与单侧塑形。 */
export function grid(doc) {
  const base = sectionRadii(doc.cross_section || defaults()), bands = (doc.section_bands || []).map((b) => [b, sectionRadii(b)]), details = doc.deformations || [];
  return doc.profile.map((radius, i) => {
    const t = i / 95;
    let values = base.map((r) => radius * r);
    for (const [band, outline] of bands) {
      const w = regionWeight(t, band.start_height_ratio, band.end_height_ratio);
      if (w) values = values.map((r, j) => r * (1 - w) + radius * outline[j] * w);
    }
    for (const d of details) {
      const v = regionWeight(t, d.start_height_ratio, d.end_height_ratio);
      if (v) values = values.map((r, j) => r + (d.radius_delta_cm / 6 + radius * d.radius_scale_percent / 100) * v * angularWeight(j * 360 / SEGMENTS, d.angle_deg, d.angular_width_deg));
    }
    return values;
  });
}

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** 横截面凸包的最大跨度（厘米）。 */
export function diameter(radii) {
  const points = radii.map((r, i) => [r * Math.sin(i * TAU / SEGMENTS), r * Math.cos(i * TAU / SEGMENTS)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), lower = [], upper = [];
  for (const [part, order] of [[lower, points], [upper, [...points].reverse()]]) {
    for (const p of order) {
      while (part.length >= 2 && cross(part[part.length - 2], part[part.length - 1], p) <= 0) part.pop();
      part.push(p);
    }
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let j = 1, longest = 0;
  for (let i = 0; i < hull.length; i++) {
    const n = (i + 1) % hull.length;
    while (Math.abs(cross(hull[i], hull[n], hull[(j + 1) % hull.length])) > Math.abs(cross(hull[i], hull[n], hull[j])) + 1e-12) j = (j + 1) % hull.length;
    longest = Math.max(longest, Math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1]), Math.hypot(hull[n][0] - hull[j][0], hull[n][1] - hull[j][1]));
  }
  return longest * 6;
}

export function stats(doc, rows = grid(doc)) {
  const envelope = Array.from({ length: SEGMENTS }, (_, j) => Math.max(...rows.map((row) => row[j])));
  return { diameter_cm: diameter(envelope), mouth_diameter_cm: diameter(rows[95]), min_radius: Math.min(...rows.map((row) => Math.min(...row))), max_radius: Math.max(...envelope) };
}

/** 外壁在面片索引里的范围：组 0 是外壁（贴釉面与纹样），组 1 是底、口沿和内壁（只有釉色）。 */
const OUTER_FIRST = 2, OUTER_LAST = 97;

export function buildGeometry(THREE, doc, rows = grid(doc)) {
  const h = doc.height / 6, rings = [{ i: 0, y: 0, center: true }, { i: 0, y: 0, inset: 0.035 }, { i: 0, y: 0.035, inset: 0 }];
  for (let i = 1; i < 96; i++) rings.push({ i, y: i / 95 * h, inset: 0 });
  for (const [inset, offset] of [[0.015, 0.018], [0.05, 0.025], [0.085, 0.018], [0.1, 0]]) rings.push({ i: 95, y: h + offset, inset });
  for (let i = 94; i >= 3; i--) rings.push({ i, y: Math.max(0.14, i / 95 * h), inset: 0.1 });
  rings.push({ i: 3, y: 0.14, inset: 0.1 }, { i: 3, y: 0.14, center: true });
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    // 外壁的 v 对应器身高度，纹样贴图按高度排布；底、口沿、内壁不贴纹样，v 只给凹凸贴图用
    const v = i >= OUTER_FIRST && i <= OUTER_LAST ? ring.i / 95 : 0.995;
    for (let j = 0; j <= SEGMENTS; j++) {
      const angle = j * TAU / SEGMENTS, r = ring.center ? 0 : Math.max(0.001, rows[ring.i][j % SEGMENTS] - ring.inset);
      positions.push(r * Math.sin(angle), ring.y, r * Math.cos(angle));
      uvs.push(j / SEGMENTS, v);
      if (i < rings.length - 1 && j < SEGMENTS) {
        const a = i * (SEGMENTS + 1) + j, b = a + SEGMENTS + 1, c = b + 1, d = a + 1;
        indices.push(a, d, b, d, c, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  const per = SEGMENTS * 6;
  geo.addGroup(0, OUTER_FIRST * per, 1);
  geo.addGroup(OUTER_FIRST * per, (OUTER_LAST - OUTER_FIRST) * per, 0);
  geo.addGroup(OUTER_LAST * per, indices.length - OUTER_LAST * per, 1);
  geo.computeVertexNormals();
  // 接缝两侧的法线取平均，避免出现一条竖线
  const normal = geo.attributes.normal;
  for (let i = 0; i < rings.length; i++) {
    const a = i * (SEGMENTS + 1), b = a + SEGMENTS;
    const n = new THREE.Vector3(normal.getX(a) + normal.getX(b), normal.getY(a) + normal.getY(b), normal.getZ(a) + normal.getZ(b)).normalize();
    normal.setXYZ(a, n.x, n.y, n.z);
    normal.setXYZ(b, n.x, n.y, n.z);
  }
  return geo;
}
