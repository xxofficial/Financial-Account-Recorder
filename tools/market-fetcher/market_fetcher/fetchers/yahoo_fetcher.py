"""Yahoo Finance fetcher via yfinance."""
import time
from typing import List, Optional
from datetime import datetime, timedelta

from market_fetcher.models import HistoricalBar
from market_fetcher.symbol_utils import strip_market_suffix
from .base import BaseFetcher


class YahooFetcher(BaseFetcher):
    source_id = "yahoo"
    source_name = "Yahoo Finance"
    source_type = "online"

    def __init__(self):
        try:
            import yfinance as yf
            self._yf = yf
        except ImportError as e:
            raise ImportError("Yahoo fetcher requires yfinance. Install: pip install yfinance") from e

    def _map_symbol(self, symbol: str, market: str, asset_type: str) -> str:
        if market == "US":
            return symbol
        if market == "HK":
            # 缺失清单里 HK 代码通常已带 .HK，避免重复追加
            core = strip_market_suffix(symbol, "HK")
            return f"{core}.HK"
        if market == "A_SHARE":
            if symbol.startswith(("60", "68", "90")):
                return f"{symbol}.SS"
            if symbol.startswith(("00", "30", "20")):
                return f"{symbol}.SZ"
            if symbol.startswith(("8", "4")):
                return f"{symbol}.BJ"
            return f"{symbol}.SS"
        return symbol

    def _next_day(self, date_str: str) -> str:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return (dt + timedelta(days=1)).strftime("%Y-%m-%d")

    def _is_valid(self, value) -> bool:
        return value is not None and value == value  # NaN check

    def _is_us_option_symbol(self, symbol: str, market: str, asset_type: str) -> bool:
        return market == "US" and asset_type.lower() == "option"

    def fetch_bars(self, symbol: str, market: str, asset_type: str, start_date: str, end_date: str) -> List[HistoricalBar]:
        if self._is_us_option_symbol(symbol, market, asset_type):
            raise ValueError(
                "Yahoo Finance 暂不支持直接拉取美式期权历史行情，"
                f"请改为拉取标的 {symbol.split()[0]} 或跳过该期权条目"
            )

        ticker_symbol = self._map_symbol(symbol, market, asset_type)
        ticker = self._yf.Ticker(ticker_symbol)
        df = ticker.history(start=start_date, end=self._next_day(end_date))

        bars: List[HistoricalBar] = []
        for index, row in df.iterrows():
            trade_date = index.strftime("%Y-%m-%d") if isinstance(index, datetime) else str(index)[:10]
            bars.append(HistoricalBar(
                symbol=symbol,
                market=market,
                asset_type=asset_type.lower(),
                trade_date=trade_date,
                open=round(float(row["Open"]), 6) if self._is_valid(row.get("Open")) else None,
                high=round(float(row["High"]), 6) if self._is_valid(row.get("High")) else None,
                low=round(float(row["Low"]), 6) if self._is_valid(row.get("Low")) else None,
                close=round(float(row["Close"]), 6) if self._is_valid(row.get("Close")) else 0.0,
                volume=int(row["Volume"]) if self._is_valid(row.get("Volume")) else None,
                provider_id=self.source_id,
                fetched_at=int(time.time() * 1000),
                data_quality="normal",
                source_id=self.source_id,
                source_name=self.source_name,
                source_type=self.source_type,
                adjusted_mode="split_dividend_adjusted",
            ))
        return bars
