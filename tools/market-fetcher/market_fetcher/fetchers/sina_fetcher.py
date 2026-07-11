"""Sina Finance fetcher for A-share daily K-line."""
import time
import ast
import json
from typing import List

import requests

from market_fetcher.models import HistoricalBar
from .base import BaseFetcher


class SinaFetcher(BaseFetcher):
    source_id = "sina"
    source_name = "Sina Finance"
    source_type = "online"

    def _map_symbol(self, symbol: str) -> str:
        if symbol.startswith(("60", "68", "90")):
            return f"sh{symbol}"
        if symbol.startswith(("00", "30", "20")):
            return f"sz{symbol}"
        if symbol.startswith(("8", "4")):
            return f"bj{symbol}"
        return f"sh{symbol}"

    def _parse_response(self, text: str) -> List[dict]:
        text = text.strip()
        if text.startswith("var"):
            text = text.split("=", 1)[-1].strip()
        if text.endswith(";"):
            text = text[:-1]
        try:
            return ast.literal_eval(text)
        except Exception:
            return json.loads(text)

    def _is_valid(self, value) -> bool:
        return value is not None and value == value

    def fetch_bars(self, symbol: str, market: str, asset_type: str, start_date: str, end_date: str) -> List[HistoricalBar]:
        if market != "A_SHARE":
            raise ValueError("Sina fetcher only supports A-share market currently")

        sina_symbol = self._map_symbol(symbol)
        url = "http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData"
        params = {"symbol": sina_symbol, "scale": "240", "ma": "no", "datalen": "1023"}
        headers = {
            "Referer": "http://finance.sina.com.cn",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        }
        resp = requests.get(url, params=params, headers=headers, timeout=30)
        resp.raise_for_status()
        data = self._parse_response(resp.text)

        bars: List[HistoricalBar] = []
        for item in data:
            trade_date = item.get("day", "")
            if trade_date < start_date or trade_date > end_date:
                continue
            bars.append(HistoricalBar(
                symbol=symbol,
                market=market,
                asset_type=asset_type.lower(),
                trade_date=trade_date,
                open=float(item.get("open", 0)) if item.get("open") is not None else None,
                high=float(item.get("high", 0)) if item.get("high") is not None else None,
                low=float(item.get("low", 0)) if item.get("low") is not None else None,
                close=float(item.get("close", 0)) if item.get("close") is not None else 0.0,
                volume=int(float(item.get("volume", 0))) if item.get("volume") is not None else None,
                provider_id=self.source_id,
                fetched_at=int(time.time() * 1000),
                data_quality="normal",
                source_id=self.source_id,
                source_name=self.source_name,
                source_type=self.source_type,
                adjusted_mode="raw",
            ))
        return bars
