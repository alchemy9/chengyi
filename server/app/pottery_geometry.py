"""Radial closed outlines and local deformations, mirrored by js/pottery/geometry.js in the web front end."""
import json
import math
from functools import lru_cache

SEGMENTS = 128
TAU = 2 * math.pi
PARTS = {"whole": (0, 1), "mouth": (.88, 1), "neck": (.68, .9), "shoulder": (.5, .72),
         "belly": (.22, .58), "base": (0, .18), "upper": (.5, 1), "middle": (.33, .67), "lower": (0, .5)}
SECTION_NAMES = {"circle": "圆形", "heart": "爱心形", "triangle": "三角形", "square": "正方形",
                 "rectangle": "长方形", "pentagon": "五边形", "hexagon": "六边形", "oval": "椭圆形",
                 "star": "星形", "flower": "花瓣形", "teardrop": "水滴形", "custom": "自定义轮廓"}


def resolve_region(args):
    if args.get("start_height_ratio") is not None:
        return args["start_height_ratio"], args["end_height_ratio"]
    return PARTS[args.get("part") or "whole"]


def region_weight(t, start, end):
    if t < start or t > end:
        return 0
    edge = min(.08, (end - start) / 3)
    weight = 1
    if start > 0:
        weight = min(weight, min(1, (t - start) / edge))
    if end < 1:
        weight = min(weight, min(1, (end - t) / edge))
    return .5 - .5 * math.cos(math.pi * weight)


def angle_distance(a, b):
    return abs((a - b + 180) % 360 - 180)


def angular_weight(angle, center, width):
    if width >= 360:
        return 1
    distance = angle_distance(angle, center)
    return .5 + .5 * math.cos(math.pi * distance / (width / 2)) if distance < width / 2 else 0


def side_angle(document, side):
    angle = document["view"]["azimuth_deg"] - document["wheel"].get("rotation_deg", 0)
    return (angle + {"front": 0, "back": 180, "left": -90, "right": 90}[side] + 180) % 360 - 180


def _path(shape):
    points = []
    for i in range(512):
        t = i * TAU / 512
        if shape == "heart":
            x = 16 * math.sin(t)**3
            z = -(13 * math.cos(t) - 5 * math.cos(2*t) - 2 * math.cos(3*t) - math.cos(4*t))
        else:
            x, z = math.sin(t) * (.7 + .3 * math.cos(t)), -math.cos(t)
        points.append((x, z))
    scale = max(math.hypot(x, z) for x, z in points)
    return [(x / scale, z / scale) for x, z in points]


def _ray(path, angle):
    dx, dz, radius = math.sin(angle), math.cos(angle), 0
    for (ax, az), (bx, bz) in zip(path, path[1:] + path[:1]):
        vx, vz = bx - ax, bz - az
        denominator = dx * vz - dz * vx
        if abs(denominator) < 1e-12:
            continue
        r, u = (ax * vz - az * vx) / denominator, (ax * dz - az * dx) / denominator
        if r > 0 and -1e-9 <= u <= 1 + 1e-9:
            radius = max(radius, r)
    return radius


def lookup(values, angle):
    index = (angle % TAU) / TAU * SEGMENTS
    first = math.floor(index) % SEGMENTS
    portion = index - math.floor(index)
    return values[first] * (1 - portion) + values[(first + 1) % SEGMENTS] * portion


@lru_cache(maxsize=128)
def _section(encoded):
    section = json.loads(encoded)
    shape, lobes = section.get("shape", "circle"), section.get("lobes", 5)
    path = _path(shape) if shape in ("heart", "teardrop") else None
    custom = section.get("points", [])
    values = []
    for i in range(SEGMENTS):
        angle = i * TAU / SEGMENTS
        if path:
            radius = _ray(path, angle)
        elif shape in ("triangle", "square", "rectangle", "pentagon", "hexagon"):
            sides = {"triangle": 3, "square": 4, "rectangle": 4, "pentagon": 5, "hexagon": 6}[shape]
            half = math.pi / sides
            phase = math.pi / 4 if sides == 4 else math.pi
            relative = (angle - phase) % (2 * half) - half
            radius = math.cos(half) / math.cos(relative)
        elif shape == "star":
            # Intersect rays with a genuine alternating outer/inner polygon.
            vertices = [(math.sin(math.pi + j * math.pi / lobes) * (1 if j % 2 == 0 else .48),
                         math.cos(math.pi + j * math.pi / lobes) * (1 if j % 2 == 0 else .48)) for j in range(lobes * 2)]
            radius = _ray(vertices, angle)
        elif shape == "flower":
            radius = .82 + .18 * math.cos(lobes * (angle - math.pi))
        elif shape == "custom":
            deg = i * 360 / SEGMENTS
            extended = [{**custom[-1], "angle_deg": custom[-1]["angle_deg"] - 360}, *custom,
                        {**custom[0], "angle_deg": custom[0]["angle_deg"] + 360}]
            for left, right in zip(extended, extended[1:]):
                if left["angle_deg"] <= deg <= right["angle_deg"]:
                    u = (deg - left["angle_deg"]) / (right["angle_deg"] - left["angle_deg"])
                    radius = left["radius_ratio"] * (1 - u) + right["radius_ratio"] * u
                    break
        else:
            radius = 1
        values.append(radius)
    width = math.ceil(section.get("roundness", .2) * 8)
    if width:
        sigma = max(.6, width * .55)
        weights = [math.exp(-k*k / (2 * sigma*sigma)) for k in range(-width, width + 1)]
        values = [sum(values[(i + k) % SEGMENTS] * weight for k, weight in zip(range(-width, width + 1), weights)) / sum(weights) for i in range(SEGMENTS)]
    maximum = max(values)
    values = [v / maximum for v in values]
    aspect = section.get("aspect_ratio", 1)
    sx, sz = min(1, aspect), min(1, 1 / aspect)
    rotation = math.radians(section.get("rotation_deg", 0))
    result = []
    for i in range(SEGMENTS):
        angle = i * TAU / SEGMENTS - rotation
        ux, uz = math.sin(angle) / sx, math.cos(angle) / sz
        result.append(lookup(values, math.atan2(ux, uz)) / math.hypot(ux, uz))
    return tuple(result)


def section_radii(section):
    return _section(json.dumps(section, sort_keys=True, separators=(",", ":")))


def grid(document):
    base = section_radii(document.get("cross_section", {}))
    bands = [(band, section_radii(band)) for band in document.get("section_bands", [])]
    details = document.get("deformations", [])
    rows = []
    for i, radius in enumerate(document["profile"]):
        t = i / 95
        values = [radius * r for r in base]
        for band, outline in bands:
            weight = region_weight(t, band["start_height_ratio"], band["end_height_ratio"])
            if weight:
                values = [r * (1 - weight) + radius * target * weight for r, target in zip(values, outline)]
        for detail in details:
            vertical = region_weight(t, detail["start_height_ratio"], detail["end_height_ratio"])
            if vertical:
                for j in range(SEGMENTS):
                    w = vertical * angular_weight(j * 360 / SEGMENTS, detail["angle_deg"], detail["angular_width_deg"])
                    values[j] += (detail["radius_delta_cm"] / 6 + radius * detail["radius_scale_percent"] / 100) * w
        rows.append(values)
    return rows


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def diameter(radii):
    points = sorted((r * math.sin(i * TAU / SEGMENTS), r * math.cos(i * TAU / SEGMENTS)) for i, r in enumerate(radii))
    lower, upper = [], []
    for part, order in ((lower, points), (upper, reversed(points))):
        for point in order:
            while len(part) >= 2 and _cross(part[-2], part[-1], point) <= 0:
                part.pop()
            part.append(point)
    hull = lower[:-1] + upper[:-1]
    j, longest = 1, 0
    for i in range(len(hull)):
        nxt = (i + 1) % len(hull)
        while abs(_cross(hull[i], hull[nxt], hull[(j + 1) % len(hull)])) > abs(_cross(hull[i], hull[nxt], hull[j])) + 1e-12:
            j = (j + 1) % len(hull)
        longest = max(longest, math.dist(hull[i], hull[j]), math.dist(hull[nxt], hull[j]))
    return longest * 6


def geometry_stats(document):
    rows = grid(document)
    envelope = [max(row[j] for row in rows) for j in range(SEGMENTS)]
    return {"diameter_cm": diameter(envelope), "mouth_diameter_cm": diameter(rows[-1]),
            "min_radius": min(min(row) for row in rows), "max_radius": max(envelope)}
