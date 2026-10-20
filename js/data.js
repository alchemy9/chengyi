// 内容数据：器物、地图光河、陶瓷篇章文案。工作台的器形、泥料、釉色等在 js/pottery/model.js。
// 名称与说明均为示意，未经内容组核验的项目一律标“示意 / 待核实”，不写入具体史实或地域归属。

export const MAP_SIZE = { w: 1678, h: 937 };
export const CLOSEUP_SIZE = { w: 1672, h: 941 };

/** 器物：地图锚点（原图像素坐标）、近景素材、开放状态。ring 顺序即近景左右邻项顺序。 */
export const OBJECTS = [
  {
    id: 'puppet', name: '人偶', label: '人偶 · 示意', craft: '待定品类',
    status: 'soon', statusText: '即将开放 · 仅供预览',
    desc: '这件器物的品类与出处尚在核实中，本期仅作预览。',
    map: { x: 1240, y: 186, w: 137, h: 186, img: 'assets/img/map-puppet.png' },
    solid: 'assets/img/map-puppet.png', particle: 'assets/img/map-puppet.png', centerH: 290, sideH: 230, // 原图 186px 高，放大不超过约 1.6 倍
  },
  {
    id: 'papercut', name: '团花纹饰', label: '团花纹饰 · 示意', craft: '剪纸（示意）',
    status: 'soon', statusText: '即将开放 · 仅供预览',
    desc: '圆形团花，形似剪纸。工坊尚未开放，本期仅作预览。',
    map: { x: 126, y: 271, w: 109, h: 100, img: 'assets/img/map-papercut.png' },
    solid: 'assets/img/map-papercut.png', particle: 'assets/img/obj-papercut-particle.png', overlay: 'assets/img/obj-papercut-particle.png',
    centerH: 230, sideH: 220, // 实体原图仅 100px，叠加高清粒子图补细节
  },
  {
    id: 'celadon', name: '青瓷云纹瓶', label: '青瓷云纹瓶', craft: '陶瓷',
    status: 'open', statusText: '陶瓷 · 已开放在线创作',
    desc: '从一抔土开始，经练泥、拉坯、施釉、入窑，成为一件器。',
    map: { x: 374, y: 446, w: 166, h: 216, img: 'assets/img/map-celadon.png' },
    solid: 'assets/img/obj-celadon.png', particle: 'assets/img/obj-celadon.png', centerH: 480, sideH: 300,
  },
  {
    id: 'filigree', name: '花丝饰件', label: '花丝饰件 · 示意', craft: '金工（示意）',
    status: 'soon', statusText: '即将开放 · 仅供预览',
    desc: '金色镂空饰件，镶彩石。工坊尚未开放，本期仅作预览。',
    map: { x: 1365, y: 544, w: 223, h: 166, img: 'assets/img/map-filigree.png' },
    solid: 'assets/img/map-filigree.png', particle: 'assets/img/obj-filigree-particle.png', overlay: 'assets/img/obj-filigree-particle.png',
    centerH: 250, sideH: 250,
  },
  {
    id: 'basket', name: '编篮', label: '编篮 · 示意', craft: '编织（示意）',
    status: 'soon', statusText: '即将开放 · 仅供预览',
    desc: '一只小提篮，形似竹编。工坊尚未开放，本期仅作预览。',
    map: { x: 480, y: 273, w: 64, h: 73, img: 'assets/img/map-basket.png' },
    solid: 'assets/img/map-basket.png', particle: 'assets/img/map-basket.png', centerH: 150, sideH: 170, // 原图仅 73px 高
  },
];

export const objectById = (id) => OBJECTS.find((o) => o.id === id);

/** 过场视频尾帧与地图底图的对应关系（SIFT 特征匹配测得，视频最后一秒镜头基本静止）：
 *  地图像素 = s · 视频像素 + (tx, ty)。视频原尺寸 w×h。 */
export const VIDEO_TO_MAP = { s: 1.328, tx: -14.5, ty: -15, w: 1280, h: 720 };

/** 地图光河中心线（地图原图像素坐标，由远到近）。 */
export const RIVER = [
  [889, 148], [906, 176], [839, 210], [772, 235], [873, 260], [965, 294], [906, 319], [722, 336],
  [646, 361], [621, 403], [671, 440], [772, 470], [906, 503], [1032, 545], [1091, 579], [1074, 618],
  [1015, 654], [982, 696], [940, 747], [873, 789], [772, 826], [688, 864], [646, 923],
];

/** 陶瓷篇章：八幕，range 为整段滚动进度区间。文案依据《陶瓷篇章-产品与交互规格》。 */
export const ACTS = [
  { id: 'soil', num: '壹', range: [0, 0.14], title: '择土 · 寻泥为胎', body: ['瓷石为骨，高岭为魂；', '经粉碎、淘洗，沉淀成细腻的泥。'], side: 'right' },
  { id: 'clay', num: '贰', range: [0.14, 0.26], title: '练泥 · 陈腐揉匀', body: ['陈藏数月，反复揉练，', '排尽气泡，使泥性温润致密。'], side: 'left' },
  { id: 'form', num: '叁', range: [0.26, 0.38], title: '成形 · 拉坯利坯', body: ['转轮拉坯，初见器形；', '半干后持刀修削，薄厚合度、形神始定。'], side: 'right' },
  { id: 'glaze', num: '肆', range: [0.38, 0.55], title: '施釉 · 着衣彩绘', notes: ['青花绘于素胎', '再覆釉浆', '静待窑火'], side: 'left' },
  { id: 'kiln', num: '伍', range: [0.55, 0.68], title: '入窑 · 一窑天成', body: ['千三百度窑火，历氧化、还原而瓷化；', '火尽开窑，釉色天成。'], side: 'left' },
  { id: 'done', num: '陆', range: [0.68, 0.78], title: '完成作品', side: 'top' },
  { id: 'return', num: '柒', range: [0.78, 0.92], title: '消解 · 归土', side: 'top' },
  { id: 'legacy', num: '捌', range: [0.92, 1], title: '承艺', steps: ['择土', '练泥', '成形', '施釉', '入窑'], side: 'top' },
];

/** 陶瓷篇章的过场视频（可选）。文件放进 assets/story/video/ 后自动启用，随滚动逐帧播放（向上滚动倒放），
 *  覆盖该区间内的代码动画；没有文件时用代码动画。range 为篇章滚动进度区间。
 *  视频首帧 = 上一幕定格画面，尾帧 = 下一幕定格画面（均为去字后的 assets/story/sN.jpg）。
 *  转码：tools/encode_scrub.sh 输入.mp4 输出.mp4（全关键帧，拖动不卡）。提示词见 docs/视频模型分镜.md。 */
export const STORY_VIDEOS = [
  { id: 'v1', src: 'assets/story/video/v1-soil-to-clay.mp4', range: [0.11, 0.17] },
  { id: 'v2', src: 'assets/story/video/v2-clay-to-form.mp4', range: [0.23, 0.29] },
  { id: 'v3', src: 'assets/story/video/v3-form-to-glaze.mp4', range: [0.35, 0.41] },
  { id: 'v4', src: 'assets/story/video/v4-glaze-push-in.mp4', range: [0.425, 0.475] },
  { id: 'v5', src: 'assets/story/video/v5-glaze-to-kiln.mp4', range: [0.52, 0.58] },
  { id: 'v6', src: 'assets/story/video/v6-kiln-to-done.mp4', range: [0.65, 0.71] },
  { id: 'v7', src: 'assets/story/video/v7-shatter.mp4', range: [0.785, 0.915] },
  { id: 'v8', src: 'assets/story/video/v8-soil-to-stage.mp4', range: [0.915, 0.975] },
];
