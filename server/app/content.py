from collections import Counter
import re

from fastapi import HTTPException
from app.models import HeritageItem, Hotspot, KnowledgeEntry


def get_item(db, item_id: str, public=True):
    item = db.get(HeritageItem, item_id)
    if item is None or (public and not item.published):
        raise HTTPException(404, "物品不存在或尚未发布")
    return item


def item_dict(item, admin=False):
    data = {
        "id": item.id, "name": item.name, "category": item.category,
        "region": item.region, "summary": item.summary,
        "introduction": item.introduction, "image_url": item.image_url,
        "is_demo": item.is_demo,
        "hotspots": [{"key": h.key, "name": h.name, "description": h.description,
                      "action_type": h.action_type, "action_target": h.action_target} for h in item.hotspots],
    }
    if admin:
        data["published"] = item.published
        data["knowledge"] = [{"title": k.title, "content": k.content, "source_name": k.source_name,
                              "source_url": k.source_url, "reviewed": k.reviewed} for k in item.knowledge]
    return data


def save_item(db, payload, existing=None):
    item = existing or HeritageItem(id=payload.id)
    data = payload.model_dump(mode="json", exclude={"id", "hotspots", "knowledge"})
    for key, value in data.items():
        setattr(item, key, value)
    item.hotspots = [Hotspot(**h.model_dump()) for h in payload.hotspots]
    item.knowledge = [KnowledgeEntry(**k.model_dump(mode="json")) for k in payload.knowledge]
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def tokens(text):
    lowered = text.lower()
    words = re.findall(r"[a-z0-9]+", lowered)
    for part in re.findall(r"[\u4e00-\u9fff]+", lowered):
        words.extend(part[i:i + 2] for i in range(len(part) - 1))
    return Counter(words)


def retrieve(item, question="", hotspot=None):
    """第一版使用物品范围内的关键词检索；未经审核的知识条目不进入模型上下文。"""
    query = tokens(question)
    entries = [k for k in item.knowledge if k.reviewed]
    scored = [(sum((query & tokens(k.title + " " + k.content)).values()), k) for k in entries]
    ranked = sorted(scored, key=lambda row: (-row[0], row[1].id))[:5]
    sources = [{"id": "overview:" + item.id, "title": item.name + "简介",
                "content": item.introduction, "source_name": "示例资料（待审核）" if item.is_demo else "项目管理员录入",
                "source_url": None, "is_demo": item.is_demo}]
    if hotspot:
        sources.append({"id": "hotspot:" + hotspot.key, "title": hotspot.name,
                        "content": hotspot.description, "source_name": "物品部位资料", "source_url": None,
                        "is_demo": item.is_demo})
    sources.extend({"id": k.id, "title": k.title, "content": k.content,
                    "source_name": k.source_name, "source_url": k.source_url,
                    "is_demo": item.is_demo} for _, k in ranked)
    return sources
