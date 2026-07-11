"""读取主应用导出的 missing-market-data-v1.json。"""
import json
from typing import List, Dict, Any


def read_missing_package(path: str) -> List[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("Missing market data file must be a JSON object")
    version = data.get("version")
    if version != "missing-market-data-v1":
        raise ValueError(f"Unsupported missing market data version: {version}")
    items = data.get("items", [])
    if not isinstance(items, list):
        raise ValueError("items must be a list")
    return items
