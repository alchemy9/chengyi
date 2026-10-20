"""承艺 3.0 素材预处理。

从 承艺3.0/ 交接文件夹读取原始素材，输出到 chengyi-web/assets/。
- 陶瓷篇章整图：去掉烘焙在图里的文字（改用网页文字），输出 JPEG 底图
- 主体抠图：按颜色/亮度阈值得到带 alpha 的 PNG，用于主体独立运动
- 其余背景转 JPEG/WebP 压缩

运行：python3 tools/prep_assets.py <承艺3.0 文件夹路径>
依赖：pillow numpy scipy opencv-python-headless rembg[cpu]（首次运行会下载 BiRefNet 抠图模型，约 1GB）
可选：simple-lama-inpainting + torch（主体移走后的底图修补，效果明显好于 OpenCV）
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi
import cv2

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
PK = os.path.join(SRC, '承艺-代码实现交接包-樊烨')
PROC = os.path.join(SRC, '过程打包文件')


def load(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.float32)


def save_jpg(arr, path, q=86, max_w=None):
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    if max_w and im.width > max_w:
        im = im.resize((max_w, round(im.height * max_w / im.width)), Image.LANCZOS)
    im.save(path, 'JPEG', quality=q, optimize=True, progressive=True)


def lum(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def fill_holes_normconv(img, hole, dark_only=False):
    """用多尺度归一化卷积把 hole 区域填为周围的颜色（适合暗色雾气背景）。
    dark_only：只用较暗的像素估计，避免主体周围的辉光把填补区染灰。"""
    out = img.copy()
    known = ~hole
    if dark_only:
        L = lum(img)
        known &= L < np.percentile(L[~hole], 88)
    known = known.astype(np.float32)
    remaining = hole.copy()
    for sigma in (3, 6, 12, 24, 48, 96):
        w = ndi.gaussian_filter(known, sigma)
        acc = np.stack([ndi.gaussian_filter(img[..., c] * known, sigma) for c in range(3)], -1)
        est = acc / np.maximum(w[..., None], 1e-4)
        ok = remaining & (w > 0.25)
        out[ok] = est[ok]
        remaining &= ~ok
        if not remaining.any():
            break
    if remaining.any():
        out[remaining] = est[remaining]
    # 加入雾状低频纹理和细噪点，避免填补区过于平滑
    rng = np.random.default_rng(7)
    fog = ndi.gaussian_filter(rng.normal(0, 1, out.shape[:2]).astype(np.float32), 18)
    fog = fog / (np.abs(fog).max() + 1e-6) * (14 if dark_only else 4)
    grain = rng.normal(0, 1.6, out.shape).astype(np.float32)
    out[hole] += grain[hole] + fog[hole][:, None] * np.array([0.7, 1.0, 1.05], np.float32)
    # 羽化接缝
    soft = ndi.gaussian_filter(hole.astype(np.float32), 10.0 if dark_only else 2.0)[..., None]
    soft = np.clip(soft * (1.6 if dark_only else 1.0), 0, 1)
    return img * (1 - soft) + out * soft


_LAMA = None


def inpaint_plate(img, hole):
    """主体移走后的底图：优先用 LaMa（学习式修补，能补出雾气纹理）；未安装时退回 Telea。"""
    global _LAMA
    try:
        from simple_lama_inpainting import SimpleLama
        if _LAMA is None:
            _LAMA = SimpleLama()
        h, w = hole.shape
        res = _LAMA(Image.fromarray(img.astype(np.uint8)), Image.fromarray((hole * 255).astype(np.uint8)))
        fill = np.asarray(res.convert('RGB'))[:h, :w].astype(np.float32)
        soft = np.clip(ndi.gaussian_filter(hole.astype(np.float32), 3.0)[..., None] * 1.4, 0, 1)
        return img * (1 - soft) + fill * soft
    except ImportError:
        pass
    return inpaint_plate_telea(img, hole)


def inpaint_plate_telea(img, hole):
    """半分辨率 Telea 修补，保留周围雾气与光晕的走向，再叠细噪点。"""
    h, w = hole.shape
    small = cv2.resize(img.astype(np.uint8), (w // 2, h // 2), interpolation=cv2.INTER_AREA)
    m = cv2.resize(hole.astype(np.uint8) * 255, (w // 2, h // 2), interpolation=cv2.INTER_NEAREST)
    fill = cv2.inpaint(cv2.cvtColor(small, cv2.COLOR_RGB2BGR), m, 18, cv2.INPAINT_TELEA)
    fill = cv2.cvtColor(fill, cv2.COLOR_BGR2RGB)
    fill = cv2.GaussianBlur(fill, (0, 0), 6)
    fill = cv2.resize(fill, (w, h), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    rng = np.random.default_rng(3)
    fill += rng.normal(0, 1.8, fill.shape).astype(np.float32)
    soft = ndi.gaussian_filter(hole.astype(np.float32), 8.0)[..., None]
    soft = np.clip(soft * 1.5, 0, 1)
    return img * (1 - soft) + fill * soft


def remove_text(img, boxes, thr=16, grow=3, extra=None):
    """boxes: [(x0,y0,x1,y1)]。在框内检测比局部背景亮的笔画（连同字的辉光一起），用 LaMa 修补。
    之前用卷积填补会留下字形的暗影，已弃用。"""
    L = lum(img)
    bg = ndi.median_filter(L, size=31)
    mask = np.zeros(L.shape, bool)
    for (x0, y0, x1, y1) in boxes:
        sub = (L[y0:y1, x0:x1] - bg[y0:y1, x0:x1]) > thr
        mask[y0:y1, x0:x1] |= sub
    # 先连通笔画，再外扩覆盖辉光
    mask = ndi.binary_closing(mask, iterations=2)
    mask = ndi.binary_dilation(mask, iterations=grow + 4)
    if extra is not None:
        mask |= extra
    return inpaint_plate(img, mask)


_SESSION = None


def matte(img, box, pad=60):
    """BiRefNet 抠图：在主体周围裁一块（保证模型输入分辨率），得到柔和、无锯齿的 alpha。
    返回裁到 box 的 RGBA 与整图 alpha（0..1）。"""
    global _SESSION
    from rembg import new_session, remove
    if _SESSION is None:
        _SESSION = new_session('birefnet-general')
    x0, y0, x1, y1 = box
    H, W = img.shape[:2]
    X0, Y0, X1, Y1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
    sub = Image.fromarray(img[Y0:Y1, X0:X1].astype(np.uint8))
    a = np.asarray(remove(sub, session=_SESSION, only_mask=True, post_process_mask=False)).astype(np.float32) / 255
    full = np.zeros((H, W), np.float32)
    full[Y0:Y1, X0:X1] = a
    full[:y0, :] = 0; full[y1:, :] = 0; full[:, :x0] = 0; full[:, x1:] = 0
    # 去掉远离主体的零星小块
    lab, n = ndi.label(full > 0.5)
    if n > 1:
        sizes = ndi.sum(full > 0.5, lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i in range(n) if sizes[i] >= sizes.max() * 0.002])
        full *= ndi.binary_dilation(keep, iterations=6) | (full < 0.5)
    rgba = np.dstack([img[y0:y1, x0:x1], full[y0:y1, x0:x1] * 255]).astype(np.uint8)
    return rgba, full


def save_png(rgba, path):
    im = Image.fromarray(rgba, 'RGBA')
    bb = im.getbbox()
    im.save(path, optimize=True)
    return bb


def main():
    story = os.path.join(OUT, 'story')
    img_out = os.path.join(OUT, 'img')
    os.makedirs(story, exist_ok=True)
    os.makedirs(img_out, exist_ok=True)
    meta = {}

    # 章节序号（顶部）与正文框，坐标基于 1672×941
    TOP = (770, 20, 905, 105)
    text_boxes = {
        '1': [TOP, (1110, 335, 1550, 535)],
        '2': [TOP, (205, 325, 580, 510)],
        '3': [TOP, (995, 325, 1490, 515)],
        '4': [],
        '5': [TOP, (190, 240, 640, 330), (430, 355, 880, 395), (430, 500, 860, 545), (430, 645, 845, 695)],
        '6': [TOP, (120, 290, 570, 490)],
        '7': [(740, 25, 920, 90)],
        '8': [(740, 25, 920, 90)],
        '9': [(740, 35, 930, 105), (145, 195, 280, 650)],
        '9，1': [(740, 35, 930, 105), (145, 195, 280, 650)],
    }
    files = {'5': '5-瓶身放大顶部统一.png'}
    clean = {}
    for k, boxes in text_boxes.items():
        img = load(os.path.join(PROC, files.get(k, k + '.png')))
        if img.shape[1] != 1672:
            img = np.asarray(Image.fromarray(img.astype(np.uint8)).resize((1672, 941), Image.LANCZOS)).astype(np.float32)
        thr = 7 if k in ('9', '9，1', '5') else 10
        extra = None
        if k == '5':
            # 图 5 的三条引线一直连到瓶身边缘，靠近瓶身的一段在辉光里检测不出来，按原图位置补画遮罩
            from PIL import ImageDraw
            m = Image.new('L', (1672, 941), 0)
            dr = ImageDraw.Draw(m)
            for (x0, y0, x1, y1, x2, y2) in [(620, 376, 718, 376, 880, 428), (566, 522, 718, 522, 856, 570), (566, 670, 700, 670, 838, 726)]:
                dr.line([(x0, y0), (x1, y1), (x2, y2)], fill=255, width=9)
                dr.ellipse((x2 - 9, y2 - 9, x2 + 9, y2 + 9), fill=255)
            extra = np.asarray(m) > 0
        c = remove_text(img, boxes, thr=thr, extra=extra) if boxes else img
        clean[k] = c
        name = '9b' if k == '9，1' else k
        save_jpg(c, os.path.join(story, f's{name}.jpg'))

    # 主体抠图：box 与阈值逐张设定
    cut_specs = {
        # 名称: (源, box, 阈值)
        'heap': ('1', (90, 290, 870, 700), 70),
        'clay': ('2', (940, 290, 1410, 730), 85),
        'biscuit': ('3', (385, 225, 750, 730), 80),
        'vase4': ('4', (1030, 280, 1250, 580), 120),
        'vase6': ('6', (1070, 385, 1215, 570), 0),
    }
    for name, (src, box, _thr) in cut_specs.items():
        rgba, al = matte(clean[src], box)
        save_png(rgba, os.path.join(story, f'cut-{name}.png'))
        meta[name] = {'src': src, 'x': box[0], 'y': box[1], 'w': box[2] - box[0], 'h': box[3] - box[1]}
        # 底图去主体：主体移走后露出的部分用 Telea 修补
        # 有辉光的主体（泥团、素坯、瓷瓶）要连同光晕一起去掉，否则修补时会沿光晕“长回”一个淡影
        grow = {'heap': 14, 'clay': 42, 'biscuit': 42, 'vase4': 34, 'vase6': 10}[name]
        hole = ndi.binary_dilation(al > 0.03, iterations=grow)
        plate = inpaint_plate(clean[src], hole)
        save_jpg(plate, os.path.join(story, f's{src}-plate.jpg'))

    # 图 8 去掉瓶、碎片和土堆后的纯背景：第 7 幕瓶体移走后用它（图 7 中央的辉光区太大，修补会留下光斑）
    s8 = clean['8']
    _, a8 = matte(s8, (560, 150, 1500, 930), pad=40)
    warm = ((s8[..., 0] - s8[..., 2]) > 18) & (lum(s8) > 70)
    warm[:150, :] = False; warm[:, :540] = False
    h8 = ndi.binary_dilation((a8 > 0.03) | ndi.binary_dilation(warm, iterations=2), iterations=18)
    save_jpg(inpaint_plate(s8, h8), os.path.join(story, 's8-plate.jpg'))

    # 图 8 底部的泥土堆（破碎终态的落点），用于“消解归土”逐渐堆积
    rgba, _ = matte(clean['8'], (560, 680, 960, 900))
    save_png(rgba, os.path.join(story, 'cut-pile8.png'))
    meta['pile8'] = {'src': '8', 'x': 560, 'y': 680, 'w': 400, 'h': 220}

    # 图 9 与 9，1 是同一场景有无土堆，两图相减即得土堆的 alpha（比抠图更准，边缘自然）
    A9, B9 = clean['9'], clean['9，1']
    diff = np.abs(B9 - A9).max(-1)
    diff = ndi.gaussian_filter(diff, 1.2)
    al = np.clip((diff - 10) / 28, 0, 1)
    al[:430, :] = 0
    al[:, :520] = 0; al[:, 1150:] = 0
    lab, n = ndi.label(al > 0.5)
    if n > 1:
        sizes = ndi.sum(al > 0.5, lab, range(1, n + 1))
        al *= ndi.binary_dilation(np.isin(lab, [i + 1 for i in range(n) if sizes[i] >= sizes.max() * 0.01]), iterations=10)
    box = (560, 450, 1110, 700)
    rgba = np.dstack([B9[box[1]:box[3], box[0]:box[2]], al[box[1]:box[3], box[0]:box[2]] * 255]).astype(np.uint8)
    save_png(rgba, os.path.join(story, 'cut-heap9.png'))
    meta['heap9'] = {'src': '9b', 'x': box[0], 'y': box[1], 'w': box[2] - box[0], 'h': box[3] - box[1]}

    # ChatGPT 图像：纯黑底上的成品青花瓶，阈值即可干净抠出，供“成器 / 破碎”使用
    v = load(os.path.join(PROC, 'ChatGPT 图像 2026年10月18日 16_31_03.png'))
    a = np.clip((v.max(-1) - 14) / 30, 0, 1)
    m = ndi.binary_fill_holes(a > 0.5)
    a = np.maximum(a, ndi.gaussian_filter(m.astype(np.float32), 1.0))
    rgba = np.dstack([v, a * 255]).astype(np.uint8)
    im = Image.fromarray(rgba, 'RGBA')
    im = im.crop(im.getbbox())
    im.save(os.path.join(story, 'vase-final.png'), optimize=True)
    meta['vaseFinal'] = {'w': im.width, 'h': im.height}

    # 图 7：按成品瓶轮廓（与网页中放置位置一致：606,166 起，434×640）去掉瓶体，瓶后留下光晕
    vx, vy, vw, vh = 606, 166, 434, 640
    al = np.asarray(im.split()[-1].resize((vw, vh), Image.LANCZOS)) > 40
    h7 = np.zeros(clean['7'].shape[:2], bool)
    h7[vy:vy + vh, vx:vx + vw] = al
    h7 = ndi.binary_dilation(h7, iterations=56)
    save_jpg(inpaint_plate(clean['7'], h7), os.path.join(story, 's7-plate.jpg'))

    with open(os.path.join(story, 'cuts.json'), 'w') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    # 其余背景
    for src, dst in [
        (os.path.join(PK, 'backgrounds', 'prologue-clean.png'), 'prologue.jpg'),
        (os.path.join(PK, 'backgrounds', 'map-clean.png'), 'map.jpg'),
        (os.path.join(PK, 'backgrounds', 'object-clean.png'), 'object.jpg'),
        (os.path.join(PK, '青瓷近景-分层PNG-v1', '04-后背景.png'), 'object-sky.jpg'),
    ]:
        save_jpg(load(src), os.path.join(img_out, dst), q=88)
    # 透明分层：缩小后保存 PNG
    for src, dst, w in [
        (os.path.join(PK, '青瓷近景-分层PNG-v1', '03-山地.png'), 'object-hills.png', 1672),
        (os.path.join(PK, '青瓷近景-分层PNG-v1', '02-银河光.png'), 'object-river.png', 1672),
        (os.path.join(PK, '青瓷近景-分层PNG-v1', '05-前景.png'), 'object-front.png', 1672),
        (os.path.join(PK, '青瓷近景-分层PNG-v1', '01-单个物品', '01-青瓷瓶.png'), 'obj-celadon.png', 900),
        (os.path.join(PK, '青瓷近景-分层PNG-v1', '01-单个物品', '02-左侧粒子圆饰.png'), 'obj-papercut-particle.png', 900),
        (os.path.join(PK, '青瓷近景-分层PNG-v1', '01-单个物品', '03-右侧粒子饰件.png'), 'obj-filigree-particle.png', 900),
    ]:
        im = Image.open(src).convert('RGBA')
        bb = im.getbbox()
        if bb:
            im = im.crop(bb) if 'obj-' in dst else im
        if im.width > w:
            im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        im.save(os.path.join(img_out, dst), optimize=True)
    # 地图五件物品（原像素，不放大）
    items = os.path.join(PK, '地图五件物品-独立PNG')
    for f, dst in [('01-圆形纹饰.png', 'map-papercut.png'), ('02-编织篮.png', 'map-basket.png'),
                   ('03-人偶.png', 'map-puppet.png'), ('04-青瓷瓶.png', 'map-celadon.png'),
                   ('05-金色饰件.png', 'map-filigree.png')]:
        Image.open(os.path.join(items, f)).save(os.path.join(img_out, dst), optimize=True)
    print('done')


if __name__ == '__main__':
    main()
