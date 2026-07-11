"""Fetcher 抽象基类。"""
from abc import ABC, abstractmethod
from typing import List
from market_fetcher.models import HistoricalBar


class BaseFetcher(ABC):
    @property
    @abstractmethod
    def source_id(self) -> str:
        ...

    @property
    @abstractmethod
    def source_name(self) -> str:
        ...

    @property
    @abstractmethod
    def source_type(self) -> str:
        ...

    @abstractmethod
    def fetch_bars(self, symbol: str, market: str, asset_type: str, start_date: str, end_date: str) -> List[HistoricalBar]:
        ...
