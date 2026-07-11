"""将抓取到的 HistoricalBar 列表写入 market-cache-v1.json。"""
import json
from datetime import datetime, timezone
from typing import List

from market_fetcher.models import HistoricalBar, MarketCachePackage


def build_cache_package(bars: List[HistoricalBar]) -> MarketCachePackage:
    """构建 market-cache-v1 数据包，并自动按 securityKey 生成 coverage。"""
    from collections import defaultdict

    by_security: defaultdict[str, List[HistoricalBar]] = defaultdict(list)
    for bar in bars:
        key = f"{bar.market}:{bar.symbol}"
        by_security[key].append(bar)

    coverage_list = []
    for key, bar_list in by_security.items():
        bar_list.sort(key=lambda b: b.trade_date)
        first = bar_list[0]
        last = bar_list[-1]
        coverage_list.append({
            "securityKey": key,
            "resolution": "1d",
            "fromDate": first.trade_date,
            "toDate": last.trade_date,
            "providerId": last.provider_id or last.source_id or "unknown",
            "coverageStatus": "complete",
            "updatedAt": last.fetched_at or int(datetime.now(timezone.utc).timestamp() * 1000),
            "sourceId": last.source_id,
            "sourceName": last.source_name,
            "sourceType": last.source_type,
            "adjustedMode": last.adjusted_mode,
        })

    return MarketCachePackage(
        generated_at=datetime.now(timezone.utc).isoformat(),
        bars=[bar.to_cache_dict() for bar in bars],
        coverage=coverage_list,
    )


def write_cache_package_to_file(bars: List[HistoricalBar], path: str) -> None:
    package = build_cache_package(bars)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(package.to_dict(), f, ensure_ascii=False, indent=2)
