"""The same 96-ring, centimeter-scaled pottery model used by the web workbench (js/pottery/model.js)."""
import copy
import math

from fastapi import HTTPException

from app.workbench_schemas import STAGE_POLAR_DEG, Document, ToolCall, CrossSection
from app.pottery_geometry import (SECTION_NAMES, angular_weight, geometry_stats, resolve_region,
                                   region_weight, side_angle)

N = 96
HEIGHTS = {"vase": 28, "jar": 23, "bowl": 12, "cup": 22, "yuhuchun": 30}
MATERIALS = {"terracotta": ("赤陶泥", 25), "cream": ("白瓷泥", 40), "celadon": ("青瓷釉", 72),
             "blue": ("天青釉", 75), "brown": ("紫砂泥", 12), "charcoal": ("黑陶泥", 30)}
SHAPES = {"vase": "花器", "jar": "陶罐", "bowl": "茶碗", "cup": "直筒杯", "yuhuchun": "玉壶春瓶"}
GLAZES = {"none": "素烧（不施釉）", "yingqing": "影青釉", "tianqing": "天青釉", "fenqing": "粉青釉", "douqing": "豆青釉",
          "yuebai": "月白釉", "tianbai": "甜白釉", "jilan": "霁蓝釉", "jihong": "霁红釉", "wujin": "乌金釉"}
PATTERNS = {"plain": "素面", "cloud": "云纹", "lotus": "缠枝莲纹", "wave": "海水纹"}
INKS = {"cobalt": "青花", "copper": "釉里红", "gold": "描金", "ink": "墨彩"}
# 旧版把青瓷、天青当作“材质”；现在泥料与釉分开，读到它们时改为白瓷泥施对应釉色。
LEGACY_GLAZE_MATERIALS = {"celadon": "fenqing", "blue": "tianqing"}
# 玉壶春：取自青瓷云纹瓶模型（assets/model/celadon-vase.glb）的外轮廓，96 层，单位为 6 厘米。
YUHUCHUN = [0.7, 0.746, 0.816, 0.839, 0.834, 0.816, 0.804, 0.828, 0.888, 0.952, 1.013, 1.075, 1.138, 1.198, 1.247, 1.281, 1.312, 1.354, 1.397, 1.437, 1.474, 1.509, 1.537, 1.556, 1.574, 1.597, 1.621, 1.642, 1.661, 1.677, 1.69, 1.699, 1.705, 1.709, 1.714, 1.718, 1.72, 1.72, 1.719, 1.716, 1.712, 1.707, 1.696, 1.68, 1.659, 1.634, 1.604, 1.57, 1.538, 1.513, 1.486, 1.443, 1.387, 1.325, 1.258, 1.187, 1.123, 1.075, 1.027, 0.957, 0.878, 0.807, 0.748, 0.698, 0.659, 0.635, 0.613, 0.586, 0.559, 0.537, 0.52, 0.503, 0.486, 0.472, 0.463, 0.455, 0.445, 0.437, 0.433, 0.434, 0.438, 0.443, 0.445, 0.448, 0.453, 0.464, 0.484, 0.508, 0.532, 0.553, 0.58, 0.629, 0.697, 0.756, 0.775, 0.763]
VIEWS = {"front": {"azimuth_deg": 0, "polar_deg": STAGE_POLAR_DEG},
         "perspective": {"azimuth_deg": 0, "polar_deg": STAGE_POLAR_DEG},
         "top": {"azimuth_deg": 0, "polar_deg": math.degrees(.025)}}


def profile(preset):
    if preset == "yuhuchun":
        return YUHUCHUN[:]
    values = []
    for index in range(N):
        t = index / (N - 1)
        if preset == "jar":
            radius = 1.04 + .77 * math.sin(t * math.pi) ** .75 - .13 * t
        elif preset == "bowl":
            radius = .72 + 1.57 * math.sin(t * math.pi * .46)
        elif preset == "cup":
            radius = 1.03 + .16 * t
        else:
            radius = .85 + .67 * math.exp(-((t - .31) / .29) ** 2) - .27 * math.exp(-((t - .82) / .18) ** 2) + .10 * t
        values.append(radius)
    return values


def measurements(document):
    stats = geometry_stats(document)
    return {"height_cm": document["height"], "diameter_cm": round(stats["diameter_cm"], 4),
            "mouth_diameter_cm": round(stats["mouth_diameter_cm"], 4),
            "cross_section_name": SECTION_NAMES[document.get("cross_section", {}).get("shape", "circle")],
            "section_band_count": len(document.get("section_bands", [])),
            "local_detail_count": len(document.get("deformations", [])),
            "material_name": MATERIALS[document["material"]][0], "base_shape_name": SHAPES[document["preset"]],
            "glaze_name": GLAZES[document.get("glaze", "none")], "pattern_name": PATTERNS[document.get("pattern", "plain")]}


def description(document):
    size = measurements(document)
    return (f"当前{size['base_shape_name']}高度 {size['height_cm']:g} 厘米，最大直径 {size['diameter_cm']:g} 厘米，"
            f"瓶口或碗口最宽处 {size['mouth_diameter_cm']:g} 厘米；从上面看为{size['cross_section_name']}，"
            f"有 {size['section_band_count']} 处局部形状和 {size['local_detail_count']} 处单侧塑形；泥料为{size['material_name']}，"
            f"{size['glaze_name']}，{surface(document)}，光泽 {document['gloss']:g}%。"
            f"转盘{'正在转动' if document['wheel']['rotating'] else '已经暂停'}，速度 {document['wheel']['speed_rpm']:g} 转/分钟。")


def surface(document):
    if document.get("pattern", "plain") == "plain":
        return "素面"
    return INKS[document.get("ink", "cobalt")] + PATTERNS[document["pattern"]] + ("，带开片" if document.get("crackle") else "")


def apply_batch(document, undo, redo, calls):
    document, undo, redo = copy.deepcopy((document, undo, redo))
    document = Document.model_validate(document).model_dump()
    undo = [Document.model_validate(value).model_dump() for value in undo]
    redo = [Document.model_validate(value).model_dump() for value in redo]
    effects, messages, focus = [], [], None
    group_before = None
    for raw in calls:
        call = raw if isinstance(raw, ToolCall) else ToolCall.model_validate(raw)
        kind, args = call.tool, call.arguments
        if kind in ("undo", "redo") and group_before is not None:
            if document != group_before:
                undo, redo = (undo + [group_before])[-40:], []
            group_before = None
        before = copy.deepcopy(document)
        if kind == "get_workbench_state":
            messages.append(description(document))
        elif kind == "set_base_shape":
            document.update(preset=args["shape"], profile=profile(args["shape"]), height=HEIGHTS[args["shape"]],
                            cross_section=CrossSection().model_dump(), section_bands=[], deformations=[])
            focus = {"tool": kind, "part": "whole", "side": "all"}
            messages.append("已将初始器形切换为" + SHAPES[args["shape"]] + "。")
        elif kind == "set_dimensions":
            if "height_cm" in args:
                document["height"] = args["height_cm"]
            if "diameter_cm" in args:
                ratio = args["diameter_cm"] / geometry_stats(document)["diameter_cm"]
                document["profile"] = [radius * ratio for radius in document["profile"]]
                for detail in document["deformations"]:
                    detail["radius_delta_cm"] *= ratio
            size = measurements(document)
            messages.append(f"高度已调整为 {size['height_cm']:g} 厘米，最大直径为 {size['diameter_cm']:g} 厘米。")
        elif kind == "reshape_region":
            start, end = resolve_region(args)
            center = args.get("angle_deg")
            if center is None and args["side"] != "all":
                center = side_angle(document, args["side"])
            focus = {"tool": kind, "start_height_ratio": start, "end_height_ratio": end,
                     **({"side": "all"} if center is None else {"angle_deg": center, "angular_width_deg": args["angular_width_deg"]})}
            if center is None:
                document["profile"] = [radius + (args.get("radius_delta_cm", 0) / 6 + radius * args.get("radius_scale_percent", 0) / 100)
                    * region_weight(index / (N - 1), start, end) for index, radius in enumerate(document["profile"])]
                messages.append("指定区域的轮廓已调整。")
            else:
                document["deformations"].append({"start_height_ratio": start, "end_height_ratio": end,
                    "angle_deg": center, "angular_width_deg": args["angular_width_deg"],
                    "radius_delta_cm": args.get("radius_delta_cm", 0), "radius_scale_percent": args.get("radius_scale_percent", 0)})
                document["wheel"]["rotating"] = False
                messages.append("已暂停转盘并调整指定一侧。")
        elif kind == "set_cross_section":
            start, end = resolve_region(args)
            focus = {"tool": kind, "start_height_ratio": start, "end_height_ratio": end}
            values = {key: args[key] for key in ("shape", "roundness", "rotation_deg", "aspect_ratio", "lobes", "points") if key in args}
            whole = start == 0 and end == 1
            current = document["cross_section"] if whole else next((band for band in reversed(document["section_bands"])
                if band["start_height_ratio"] == start and band["end_height_ratio"] == end), document["cross_section"])
            section = {key: value for key, value in current.items() if key not in ("start_height_ratio", "end_height_ratio")}
            if "shape" in values and values["shape"] != section["shape"]:
                section.update(points=[], aspect_ratio=1.5 if values["shape"] in ("oval", "rectangle") else 1)
            section.update(values)
            try:
                section = CrossSection.model_validate(section).model_dump()
            except ValueError:
                raise HTTPException(422, "自定义轮廓参数不完整或顺序不正确，本次没有修改作品") from None
            if whole:
                document["cross_section"] = section
                if "shape" in values:
                    document["section_bands"] = []
                    document["wheel"]["rotation_deg"] = 0
            else:
                document["section_bands"] = [band for band in document["section_bands"] if
                    (band["start_height_ratio"], band["end_height_ratio"]) != (start, end)]
                document["section_bands"].append({**section, "start_height_ratio": start, "end_height_ratio": end})
            document["wheel"]["rotating"] = False
            if "shape" in values:
                document["view"].update(direction="top", **VIEWS["top"])
            messages.append(("整体" if whole else "指定部位") + "从上面看已调整为" + SECTION_NAMES[section["shape"]]
                            + ("，已暂停转盘并切到俯视。" if "shape" in values else "，已暂停转盘便于观察。"))
        elif kind == "set_shape_profile":
            points = args["points"]
            # Monotone cubic interpolation keeps rounded shoulders without radius overshoot.
            spans = [right["height_ratio"] - left["height_ratio"] for left, right in zip(points, points[1:])]
            slopes = [(right["radius_cm"] - left["radius_cm"]) / span for left, right, span in zip(points, points[1:], spans)]
            tangents = [slopes[0]]
            for i in range(1, len(points) - 1):
                if slopes[i - 1] * slopes[i] <= 0:
                    tangents.append(0)
                else:
                    w1, w2 = 2 * spans[i] + spans[i - 1], spans[i] + 2 * spans[i - 1]
                    tangents.append((w1 + w2) / (w1 / slopes[i - 1] + w2 / slopes[i]))
            tangents.append(slopes[-1])
            result = []
            for index in range(N):
                t = index / (N - 1)
                for i, (left, right) in enumerate(zip(points, points[1:])):
                    if left["height_ratio"] <= t <= right["height_ratio"]:
                        portion = (t - left["height_ratio"]) / (right["height_ratio"] - left["height_ratio"])
                        u = portion
                        radius = ((2 * u**3 - 3 * u**2 + 1) * left["radius_cm"]
                                  + (u**3 - 2 * u**2 + u) * spans[i] * tangents[i]
                                  + (-2 * u**3 + 3 * u**2) * right["radius_cm"]
                                  + (u**3 - u**2) * spans[i] * tangents[i + 1])
                        result.append(radius / 6)
                        break
            document["profile"] = result
            focus = {"tool": kind, "part": "whole", "side": "all"}
            if "shape" in args:
                document["preset"] = args["shape"]
            if "height_cm" in args:
                document["height"] = args["height_cm"]
            messages.append("器形已按照新的轮廓调整。")
        elif kind == "smooth_surface":
            start_ratio, end_ratio = resolve_region(args)
            previous_details = copy.deepcopy(document["deformations"])
            center = args.get("angle_deg")
            if center is None and args["side"] != "all":
                center = side_angle(document, args["side"])
            focus = {"tool": kind, "start_height_ratio": start_ratio, "end_height_ratio": end_ratio,
                     **({"side": "all"} if center is None else {"angle_deg": center, "angular_width_deg": args["angular_width_deg"]})}
            for _ in range(args["passes"] if center is None else 0):
                original = document["profile"][:]
                for index, radius in enumerate(original):
                    start, end = max(0, index - 3), min(N, index + 4)
                    average = sum(original[start:end]) / (end - start)
                    weight = region_weight(index / (N - 1), start_ratio, end_ratio)
                    document["profile"][index] = radius + (average - radius) * args["strength"] * weight
            for detail in document["deformations"]:
                overlap = max(0, min(end_ratio, detail["end_height_ratio"]) - max(start_ratio, detail["start_height_ratio"]))
                weight = min(1, overlap / (detail["end_height_ratio"] - detail["start_height_ratio"]))
                if center is not None:
                    weight *= angular_weight(detail["angle_deg"], center, args["angular_width_deg"])
                scale = 1 - args["strength"] * weight
                detail["radius_delta_cm"] *= scale
                detail["radius_scale_percent"] *= scale
            document["deformations"] = [detail for detail in document["deformations"] if
                abs(detail["radius_delta_cm"]) > .005 or abs(detail["radius_scale_percent"]) > .05]
            if center is not None:
                document["wheel"]["rotating"] = False
            messages.append("这一侧没有额外的局部凹凸。" if center is not None and previous_details == document["deformations"] else "指定区域已抚平。")
        elif kind == "set_material":
            if "material" in args:
                material = args["material"]
                document["gloss"] = MATERIALS[material][1]
                if material in LEGACY_GLAZE_MATERIALS:
                    document["material"], document["glaze"] = "cream", LEGACY_GLAZE_MATERIALS[material]
                else:
                    document["material"] = material
            if "gloss" in args:
                document["gloss"] = args["gloss"]
            messages.append(f"已选用{MATERIALS[document['material']][0]}"
                            + ("" if document["glaze"] == "none" else "，施" + GLAZES[document["glaze"]])
                            + f"，光泽为 {document['gloss']:g}%。")
        elif kind == "set_glaze":
            for key in ("glaze", "pattern", "ink", "crackle", "gloss"):
                if key in args:
                    document[key] = args[key]
            if "glaze" in args and "gloss" not in args:
                document["gloss"] = 20 if args["glaze"] == "none" else 70
            if document["glaze"] == "none":
                document["crackle"] = False
            messages.append(("已改为素烧，不施釉" if document["glaze"] == "none" else "已施" + GLAZES[document["glaze"]])
                            + "，" + surface(document) + f"，光泽为 {document['gloss']:g}%。")
        elif kind == "set_wheel":
            document["wheel"].update(args)
            messages.append(f"转盘{'已启动' if document['wheel']['rotating'] else '已暂停'}，速度为 {document['wheel']['speed_rpm']:g} 转/分钟。")
        elif kind == "set_view":
            if "direction" in args:
                document["view"].update({"direction": args["direction"], **VIEWS[args["direction"]]})
            if "zoom_percent" in args:
                document["view"]["zoom_percent"] = args["zoom_percent"]
            messages.append("观察视角已调整。")
        elif kind == "undo":
            if not undo:
                raise HTTPException(422, "当前没有可以撤销的修改")
            redo.append(copy.deepcopy(document))
            document = undo.pop()
            messages.append("已撤销上一步修改。")
        elif kind == "redo":
            if not redo:
                raise HTTPException(422, "当前没有可以恢复的修改")
            undo.append(copy.deepcopy(document))
            document = redo.pop()
            messages.append("已恢复上一步修改。")
        elif kind == "save_project":
            if "name" in args:
                document["name"] = args["name"]
            effects.append({"type": "save_project"})
            messages.append("作品已保存到后台。")
        elif kind == "export_artifact":
            effects.append({"type": "export_artifact", "format": args["format"]})
            messages.append("已生成 " + args["format"].upper() + " 文件，可从工作台下载。")
        try:
            document = Document.model_validate(document).model_dump()
        except ValueError:
            raise HTTPException(422, "这次调整会超出工作台支持的尺寸或轮廓范围，请减小调整幅度") from None
        if kind not in ("undo", "redo") and document != before:
            if group_before is None:
                group_before = before
    if group_before is not None and document != group_before:
        undo, redo = (undo + [group_before])[-40:], []
    return {"document": document, "undo": undo[-40:], "redo": redo[-40:],
            "effects": effects, "message": "\n".join(messages), "focus": focus}
