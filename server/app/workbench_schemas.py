from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, StrictBool, model_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)


Preset = Literal["vase", "jar", "bowl", "cup", "yuhuchun"]
# 泥料（择土）。celadon、blue 是旧版里的釉色，保留以便读取旧作品，set_material 会把它们换成对应釉色。
Material = Literal["terracotta", "cream", "celadon", "blue", "brown", "charcoal"]
# 施釉：釉色、纹样、纹色。none 表示素烧，不施釉。
Glaze = Literal["none", "yingqing", "tianqing", "fenqing", "douqing", "yuebai", "tianbai", "jilan", "jihong", "wujin"]
Pattern = Literal["plain", "cloud", "lotus", "wave"]
Ink = Literal["cobalt", "copper", "gold", "ink"]
ToolName = Literal["get_workbench_state", "set_base_shape", "set_dimensions", "reshape_region",
                   "set_shape_profile", "set_cross_section", "smooth_surface", "set_material", "set_glaze", "set_wheel", "set_view",
                   "undo", "redo", "save_project", "export_artifact"]
SectionShape = Literal["circle", "heart", "triangle", "square", "rectangle", "pentagon", "hexagon",
                       "oval", "star", "flower", "teardrop", "custom"]
Part = Literal["whole", "mouth", "neck", "shoulder", "belly", "base", "upper", "middle", "lower"]
Side = Literal["all", "front", "back", "left", "right"]


class PolarPoint(Input):
    angle_deg: FiniteFloat = Field(ge=0, lt=360)
    radius_ratio: FiniteFloat = Field(ge=.2, le=1)


class CrossSection(Input):
    shape: SectionShape = "circle"
    roundness: FiniteFloat = Field(default=.2, ge=0, le=1)
    rotation_deg: FiniteFloat = Field(default=0, ge=-180, le=180)
    aspect_ratio: FiniteFloat = Field(default=1, ge=.4, le=2.5)
    lobes: int = Field(default=5, ge=3, le=8, strict=True)
    points: list[PolarPoint] = Field(default_factory=list, max_length=32)

    @model_validator(mode="after")
    def custom_points(self):
        if self.shape == "custom":
            if len(self.points) < 3 or any(b.angle_deg <= a.angle_deg for a, b in zip(self.points, self.points[1:])):
                raise ValueError("自定义轮廓需要至少3个按角度递增的控制点")
        elif self.points:
            raise ValueError("只有自定义轮廓使用角度控制点")
        return self


class SectionBand(CrossSection):
    start_height_ratio: FiniteFloat = Field(ge=0, le=1)
    end_height_ratio: FiniteFloat = Field(ge=0, le=1)

    @model_validator(mode="after")
    def ordered(self):
        if self.end_height_ratio <= self.start_height_ratio:
            raise ValueError("区域结束位置必须高于开始位置")
        return self


class LocalDeformation(Input):
    start_height_ratio: FiniteFloat = Field(ge=0, le=1)
    end_height_ratio: FiniteFloat = Field(ge=0, le=1)
    angle_deg: FiniteFloat = Field(ge=-180, le=180)
    angular_width_deg: FiniteFloat = Field(default=90, ge=10, le=360)
    radius_delta_cm: FiniteFloat = Field(default=0, ge=-6, le=6)
    radius_scale_percent: FiniteFloat = Field(default=0, ge=-60, le=100)

    @model_validator(mode="after")
    def ordered(self):
        if self.end_height_ratio <= self.start_height_ratio:
            raise ValueError("区域结束位置必须高于开始位置")
        return self


class WheelState(Input):
    rotating: StrictBool = True
    speed_rpm: FiniteFloat = Field(default=30, ge=5, le=60)
    rotation_deg: FiniteFloat = Field(default=0, ge=-180, le=180)


# 工作台的主镜头固定对准展台（俯角约 6°），俯视另开小窗；方位角 0 即正对观众。
STAGE_POLAR_DEG = 83.82


class ViewState(Input):
    direction: Literal["front", "top", "perspective", "custom"] = "perspective"
    azimuth_deg: FiniteFloat = Field(default=0, ge=-360, le=360)
    polar_deg: FiniteFloat = Field(default=STAGE_POLAR_DEG, ge=1.43, le=88)
    zoom_percent: FiniteFloat = Field(default=100, ge=57, le=190)


class Document(Input):
    name: str = Field(default="未命名的陶器", min_length=1, max_length=40)
    profile: list[FiniteFloat] = Field(min_length=96, max_length=96)
    height: FiniteFloat = Field(ge=8, le=40)
    material: Material
    gloss: FiniteFloat = Field(ge=0, le=100)
    preset: Preset
    glaze: Glaze = "none"
    pattern: Pattern = "plain"
    ink: Ink = "cobalt"
    crackle: StrictBool = False
    cross_section: CrossSection = Field(default_factory=CrossSection)
    section_bands: list[SectionBand] = Field(default_factory=list, max_length=8)
    deformations: list[LocalDeformation] = Field(default_factory=list, max_length=32)
    wheel: WheelState = Field(default_factory=WheelState)
    view: ViewState = Field(default_factory=ViewState)

    @model_validator(mode="after")
    def valid_radius(self):
        if any(radius < .32 or radius > 2.9 for radius in self.profile):
            raise ValueError("轮廓半径超出工作台范围")
        from app.pottery_geometry import geometry_stats
        stats = geometry_stats(self.model_dump())
        if stats["min_radius"] < .14 - 1e-8 or stats["max_radius"] > 2.9 + 1e-8:
            raise ValueError("局部轮廓过薄或超出工作台范围，请减小变形或增大器物")
        return self


class Empty(Input):
    pass


class BaseShape(Input):
    shape: Preset


class Dimensions(Input):
    height_cm: FiniteFloat | None = Field(default=None, ge=8, le=40)
    diameter_cm: FiniteFloat | None = Field(default=None, ge=3.84, le=34.8)

    @model_validator(mode="after")
    def supplied(self):
        if self.height_cm is None and self.diameter_cm is None:
            raise ValueError("请提供高度或直径")
        return self


class Region(Input):
    start_height_ratio: FiniteFloat | None = Field(default=None, ge=0, le=1)
    end_height_ratio: FiniteFloat | None = Field(default=None, ge=0, le=1)
    part: Part | None = None

    @model_validator(mode="after")
    def ordered(self):
        if (self.start_height_ratio is None) != (self.end_height_ratio is None):
            raise ValueError("自定义区域必须同时提供开始和结束位置")
        if self.part is not None and self.start_height_ratio is not None:
            raise ValueError("部位名称和自定义高度区域只能选择一种")
        if self.start_height_ratio is not None and self.end_height_ratio <= self.start_height_ratio:
            raise ValueError("区域结束位置必须高于开始位置")
        return self


class Reshape(Region):
    radius_delta_cm: FiniteFloat | None = Field(default=None, ge=-6, le=6)
    radius_scale_percent: FiniteFloat | None = Field(default=None, ge=-60, le=100)
    side: Side = "all"
    angle_deg: FiniteFloat | None = Field(default=None, ge=-180, le=180)
    angular_width_deg: FiniteFloat = Field(default=90, ge=10, le=360)

    @model_validator(mode="after")
    def displacement(self):
        if (self.radius_delta_cm is None) == (self.radius_scale_percent is None):
            raise ValueError("请指定半径变化厘米数或变化百分比中的一项")
        if self.angle_deg is not None and self.side != "all":
            raise ValueError("具体角度和相对方向只能选择一种")
        return self


class CrossSectionChange(Region):
    shape: SectionShape | None = None
    roundness: FiniteFloat | None = Field(default=None, ge=0, le=1)
    rotation_deg: FiniteFloat | None = Field(default=None, ge=-180, le=180)
    aspect_ratio: FiniteFloat | None = Field(default=None, ge=.4, le=2.5)
    lobes: int | None = Field(default=None, ge=3, le=8, strict=True)
    points: list[PolarPoint] | None = Field(default=None, min_length=3, max_length=32)

    @model_validator(mode="after")
    def supplied(self):
        if all(getattr(self, key) is None for key in ("shape", "roundness", "rotation_deg", "aspect_ratio", "lobes", "points")):
            raise ValueError("请提供形状或轮廓参数")
        return self


class ControlPoint(Input):
    height_ratio: FiniteFloat = Field(ge=0, le=1)
    radius_cm: FiniteFloat = Field(ge=1.92, le=17.4)


class ShapeProfile(Input):
    points: list[ControlPoint] = Field(min_length=2, max_length=16)
    height_cm: FiniteFloat | None = Field(default=None, ge=8, le=40)
    shape: Preset | None = None

    @model_validator(mode="after")
    def ordered(self):
        if self.points[0].height_ratio != 0 or self.points[-1].height_ratio != 1:
            raise ValueError("轮廓控制点必须包含底部 0 和顶部 1")
        if any(b.height_ratio <= a.height_ratio for a, b in zip(self.points, self.points[1:])):
            raise ValueError("轮廓控制点必须从底部到顶部依次排列")
        return self


class Smooth(Region):
    strength: FiniteFloat = Field(default=.5, gt=0, le=1)
    passes: int = Field(default=2, ge=1, le=5, strict=True)
    side: Side = "all"
    angle_deg: FiniteFloat | None = Field(default=None, ge=-180, le=180)
    angular_width_deg: FiniteFloat = Field(default=90, ge=10, le=360)

    @model_validator(mode="after")
    def direction(self):
        if self.angle_deg is not None and self.side != "all":
            raise ValueError("具体角度和相对方向只能选择一种")
        return self


class MaterialChange(Input):
    material: Material | None = None
    gloss: FiniteFloat | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def supplied(self):
        if self.material is None and self.gloss is None:
            raise ValueError("请提供陶泥、釉色或光泽")
        return self


class GlazeChange(Input):
    glaze: Glaze | None = None
    pattern: Pattern | None = None
    ink: Ink | None = None
    crackle: StrictBool | None = None
    gloss: FiniteFloat | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def supplied(self):
        if all(getattr(self, key) is None for key in ("glaze", "pattern", "ink", "crackle", "gloss")):
            raise ValueError("请提供釉色、纹样、纹色、开片或光泽")
        return self


class WheelChange(Input):
    rotating: StrictBool | None = None
    speed_rpm: FiniteFloat | None = Field(default=None, ge=5, le=60)

    @model_validator(mode="after")
    def supplied(self):
        if self.rotating is None and self.speed_rpm is None:
            raise ValueError("请提供转盘启停或速度")
        return self


class ViewChange(Input):
    direction: Literal["front", "top", "perspective"] | None = None
    zoom_percent: FiniteFloat | None = Field(default=None, ge=57, le=190)

    @model_validator(mode="after")
    def supplied(self):
        if self.direction is None and self.zoom_percent is None:
            raise ValueError("请提供观察方向或缩放比例")
        return self


class SaveProject(Input):
    name: str | None = Field(default=None, min_length=1, max_length=40)


class ExportArtifact(Input):
    format: Literal["png", "obj", "json"]


ARGUMENTS = {"get_workbench_state": Empty, "set_base_shape": BaseShape, "set_dimensions": Dimensions,
             "reshape_region": Reshape, "set_shape_profile": ShapeProfile, "smooth_surface": Smooth,
             "set_cross_section": CrossSectionChange,
             "set_material": MaterialChange, "set_glaze": GlazeChange, "set_wheel": WheelChange, "set_view": ViewChange,
             "undo": Empty, "redo": Empty, "save_project": SaveProject, "export_artifact": ExportArtifact}


class ToolCall(Input):
    tool: ToolName
    arguments: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid_arguments(self):
        self.arguments = ARGUMENTS[self.tool].model_validate(self.arguments).model_dump(exclude_none=True)
        return self


class CreateWorkbench(Input):
    document: Document


class SyncWorkbench(Input):
    expected_revision: int = Field(ge=1)
    document: Document
    client_request_id: UUID


class WorkbenchRequest(Input):
    expected_revision: int = Field(ge=1)
    client_request_id: UUID
    text: str = Field(min_length=1, max_length=2000)


class ToolRequest(Input):
    expected_revision: int = Field(ge=1)
    client_request_id: UUID
    arguments: dict = Field(default_factory=dict)


class WorkbenchReceipt(Input):
    expected_revision: int = Field(ge=1)
    status: Literal["applied", "failed", "cancelled"]
    document: Document | None = None
    artifacts: list["ArtifactReceipt"] = Field(default_factory=list, max_length=1)


class ArtifactReceipt(Input):
    format: Literal["png", "obj", "json"]
    filename: str = Field(min_length=1, max_length=100)
    bytes: int = Field(gt=0, le=50_000_000, strict=True)


class SpeakRequest(Input):
    command_id: UUID


class WorkbenchIntent(Input):
    decision: Literal["actions", "answer", "clarify"]
    actions: list[ToolCall] = Field(default_factory=list, max_length=6)
    message: str = Field(default="", max_length=1000)

    @model_validator(mode="after")
    def coherent(self):
        if self.decision == "actions" and not self.actions:
            raise ValueError("操作列表不能为空")
        if self.decision != "actions" and self.actions:
            raise ValueError("普通回答不能附带操作")
        if sum(call.tool == "export_artifact" for call in self.actions) > 1:
            raise ValueError("每次只能导出一个文件")
        if self.decision != "actions" and not self.message:
            raise ValueError("请提供回答或确认问题")
        return self
