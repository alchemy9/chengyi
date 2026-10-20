from app.content import save_item
from app.models import HeritageItem
from app.schemas import ItemInput


def seed_demo(db):
    examples = [
        {"id": "paper-cutting", "name": "剪纸 · 演示", "category": "传统美术",
         "summary": "观察纸张上的镂空与纹样。",
         "introduction": "这是一份用于测试导览的剪纸示例资料。你可以观察纸张被剪出或刻出的镂空纹样。不同地区和用途的作品会有不同特点，正式讲解需要补充具体作品的来源和说明。",
         "hotspots": [{"key": "pattern", "name": "镂空纹样", "description": "演示部位：观察实心纸面与镂空区域的关系。具体纹样含义需要结合这件作品的正式资料说明。", "action_type": "highlight", "action_target": "pattern"}],
         "knowledge": [{"title": "演示资料使用说明", "content": "这些内容用于验证点击、讲解和导览接口，并不是某件真实藏品的权威介绍。", "source_name": "项目演示资料", "reviewed": True}]},
        {"id": "shadow-puppet", "name": "皮影 · 演示", "category": "传统戏剧",
         "summary": "观察影偶的关节和操纵部位。",
         "introduction": "这是一份皮影演示资料。皮影表演通过影偶、光线和幕布形成影像，常与音乐、唱腔配合。请点击关节部位，测试局部讲解。具体材质、流派和制作方法需要根据真实作品补充。",
         "hotspots": [{"key": "joint", "name": "活动关节", "description": "演示部位：影偶的活动连接部位可以配合操纵产生动作。前端可以为这个部位制作一段活动演示。", "action_type": "play_animation", "action_target": "joint-demo"}],
         "knowledge": []},
        {"id": "bamboo-weaving", "name": "竹编 · 演示", "category": "传统技艺",
         "summary": "观察竹条交织形成的结构。",
         "introduction": "这是一份竹编演示资料。你可以观察竹条交织形成的结构与纹理。制作步骤、用料和地方特点需要参考实际作品的资料。点击编织部位，可以测试展示步骤的互动指令。",
         "hotspots": [{"key": "weave", "name": "编织结构", "description": "演示部位：观察竹条之间交织的位置。正式步骤应由你们录入，前端按约定展示相应内容。", "action_type": "show_steps", "action_target": "weave-steps"}],
         "knowledge": []},
    ]
    for example in examples:
        if db.get(HeritageItem, example["id"]) is None:
            save_item(db, ItemInput(**example, published=True, is_demo=True))
