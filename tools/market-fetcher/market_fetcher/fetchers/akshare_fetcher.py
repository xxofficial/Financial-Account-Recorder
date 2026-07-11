"""AkShare fetcher for A-share and HK stocks."""
import time
from typing import List

from market_fetcher.models import HistoricalBar
from market_fetcher.symbol_utils import strip_market_suffix
from .base import BaseFetcher


class AkShareFetcher(BaseFetcher):
    source_id = "akshare"
    source_name = "AkShare"
    source_type = "online"

    def __init__(self):
        try:
            import akshare as ak
            self._ak = ak
        except ImportError as e:
            raise ImportError("AkShare fetcher requires akshare. Install: pip install akshare") from e

    def _is_valid(self, value) -> bool:
        return value is not None and value == value

    def _to_date(self, value) -> str:
        if hasattr(value, "strftime"):
            return value.strftime("%Y-%m-%d")
        s = str(value)
        return s[:10] if len(s) >= 10 else s

    def fetch_bars(self, symbol: str, market: str, asset_type: str, start_date: str, end_date: str) -> List[HistoricalBar]:
        if market == "A_SHARE":
            return self._fetch_a_share(symbol, asset_type, start_date, end_date)
        if market == "HK":
            return self._fetch_hk(symbol, start_date, end_date)
        raise ValueError("AkShare fetcher supports A-share and HK stocks only")

    def _fetch_a_share(self, symbol: str, asset_type: str, start_date: str, end_date: str) -> List[HistoricalBar]:
        # A-share ETF option (e.g., 50ETF, 300ETF) uses option functions
        if asset_type.lower() == "option":
            return self._fetch_a_share_option(symbol, start_date, end_date)

        df = self._ak.stock_zh_a_hist(
            symbol=symbol,
            period="daily",
            start_date=start_date.replace("-", ""),
            end_date=end_date.replace("-", ""),
            adjust="qfq",
        )
        return self._df_to_bars(df, symbol, "A_SHARE", asset_type)

    def _fetch_hk(self, symbol: str, start_date: str, end_date: str) -> List[HistoricalBar]:
        # 缺失清单里的 HK 代码可能带 .HK 后缀，统一去掉
        core = strip_market_suffix(symbol, "HK")
        df = self._ak.stock_hk_hist(
            symbol=core,
            period="daily",
            start_date=start_date.replace("-", ""),
            end_date=end_date.replace("-", ""),
            adjust="qfq",
        )
        return self._df_to_bars(df, symbol, "HK", "stock")

    def _fetch_a_share_option(self, symbol: str, start_date: str, end_date: str) -> List[HistoricalBar]:
        # Try to use akshare option functions. The symbol is expected to be like "510050P2401M02600"
        # akshare.option_cffex_hs300_daily_sina or option_cffex_50_daily_sina etc. are available.
        # We try the most common ETF options: 50ETF and 300ETF.
        try:
            df = self._ak.option_finance_board(symbol=symbol, end_date=end_date.replace("-", ""))
        except Exception as e:
            raise ValueError(f"Failed to fetch A-share option {symbol} via akshare: {e}")
        return self._df_to_bars(df, symbol, "A_SHARE", "option")

    def _df_to_bars(self, df, symbol: str, market: str, asset_type: str) -> List[HistoricalBar]:
        bars: List[HistoricalBar] = []
        columns = [c for c in df.columns]
        date_col = next((c for c in columns if "日期" in c or "date" in c.lower()), None)
        open_col = next((c for c in columns if "开盘" in c or "open" in c.lower()), None)
        high_col = next((c for c in columns if "最高" in c or "high" in c.lower()), None)
        low_col = next((c for c in columns if "最低" in c or "low" in c.lower()), None)
        close_col = next((c for c in columns if "收盘" in c or "close" in c.lower()), None)
        volume_col = next((c for c in columns if "成交量" in c or "volume" in c.lower()), None)

        for _, row in df.iterrows():
            trade_date = self._to_date(row[date_col]) if date_col else ""
            bars.append(HistoricalBar(
                symbol=symbol,
                market=market,
                asset_type=asset_type.lower(),
                trade_date=trade_date,
                open=float(row[open_col]) if open_col and self._is_valid(row[open_col]) else None,
                high=float(row[high_col]) if high_col and self._is_valid(row[high_col]) else None,
                low=float(row[low_col]) if low_col and self._is_valid(row[low_col]) else None,
                close=float(row[close_col]) if close_col and self._is_valid(row[close_col]) else 0.0,
                volume=int(float(row[volume_col])) if volume_col and self._is_valid(row[volume_col]) else None,
                provider_id=self.source_id,
                fetched_at=int(time.time() * 1000),
                data_quality="normal",
                source_id=self.source_id,
                source_name=self.source_name,
                source_type=self.source_type,
                adjusted_mode="split_dividend_adjusted",
            ))
        return bars
