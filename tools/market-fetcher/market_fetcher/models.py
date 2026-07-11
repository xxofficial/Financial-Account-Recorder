"""数据模型，对应主应用 schema。"""
from dataclasses import dataclass, field
from typing import Optional
import time


@dataclass
class HistoricalBar:
    symbol: str
    market: str
    asset_type: str
    trade_date: str
    close: float
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    volume: Optional[int] = None
    provider_id: str = ""
    fetched_at: Optional[int] = None
    data_quality: str = "normal"
    source_id: Optional[str] = None
    source_name: Optional[str] = None
    source_type: Optional[str] = None
    adjusted_mode: Optional[str] = None

    def to_cache_dict(self) -> dict:
        return {
            "id": f"{self.market}:{self.symbol}:{self.asset_type}:1d:{self.trade_date}",
            "securityKey": f"{self.market}:{self.symbol}",
            "symbol": self.symbol,
            "market": self.market,
            "assetType": self.asset_type,
            "resolution": "1d",
            "tradeDate": self.trade_date,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "providerId": self.provider_id or self.source_id or "unknown",
            "fetchedAt": self.fetched_at or int(time.time() * 1000),
            "dataQuality": self.data_quality,
            "sourceId": self.source_id,
            "sourceName": self.source_name,
            "sourceType": self.source_type,
            "adjustedMode": self.adjusted_mode,
        }


@dataclass
class MarketCachePackage:
    version: str = "market-cache-v1"
    generated_at: str = field(default_factory=lambda: __import__("datetime").datetime.utcnow().isoformat())
    generator: dict = field(default_factory=lambda: {"name": "recoder-market-fetcher", "version": "1.0.0"})
    bars: list = field(default_factory=list)
    coverage: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "generatedAt": self.generated_at,
            "generator": self.generator,
            "bars": self.bars,
            "coverage": self.coverage,
        }


@dataclass
class MissingMarketDataPackage:
    version: str = "missing-market-data-v1"
    generated_at: str = field(default_factory=lambda: __import__("datetime").datetime.utcnow().isoformat())
    items: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "generatedAt": self.generated_at,
            "items": self.items,
        }
