from .fetchers.yahoo_fetcher import YahooFetcher
from .fetchers.sina_fetcher import SinaFetcher
from .fetchers.akshare_fetcher import AkShareFetcher
from .fetchers.base import BaseFetcher
from typing import List


FETCHERS = {
    "yahoo": YahooFetcher,
    "sina": SinaFetcher,
    "akshare": AkShareFetcher,
}

# 每个市场可用的数据源顺序，第一个失败后依次回退
MARKET_FALLBACKS = {
    "HK": ["akshare", "yahoo"],
    "US": ["yahoo"],
    "A_SHARE": ["akshare", "sina"],
}


def get_fetcher(source_id: str) -> BaseFetcher:
    fetcher_cls = FETCHERS.get(source_id)
    if not fetcher_cls:
        raise ValueError(f"Unknown source id: {source_id}. Supported: {list(FETCHERS.keys())}")
    return fetcher_cls()


def resolve_sources(market: str, primary_source: str) -> List[str]:
    """返回该市场应尝试的数据源顺序，primary_source 优先。"""
    all_sources = MARKET_FALLBACKS.get(market, [])
    ordered = [primary_source] if primary_source in all_sources else []
    ordered += [s for s in all_sources if s != primary_source]
    # 如果 primary_source 不在已知列表，也把它放进去试试
    if primary_source not in ordered:
        ordered.append(primary_source)
    return ordered
