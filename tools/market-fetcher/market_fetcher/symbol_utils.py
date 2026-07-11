"""代码格式与市场相关工具函数。"""
from typing import Tuple, Optional


# 不参与行情拉取的伪标的
NON_FETCHABLE_SYMBOLS = {"CASH", "CUSTODY", "INTEREST"}


def strip_market_suffix(symbol: str, market: str) -> str:
    """去掉市场后缀，例如 0100.HK -> 0100、AAPL.SS -> AAPL。"""
    suffixes = {
        "HK": ".HK",
        "A_SHARE": [".SS", ".SZ", ".BJ", ".SH"],
        "US": [".US", ".NYSE", ".NASDAQ", ".AMEX"],
    }
    s = symbol.strip().upper()
    if market == "A_SHARE":
        for sfx in suffixes["A_SHARE"]:
            if s.endswith(sfx):
                return symbol[: -len(sfx)].strip()
    elif market == "US":
        for sfx in suffixes["US"]:
            if s.endswith(sfx):
                return symbol[: -len(sfx)].strip()
    elif market == "HK":
        sfx = suffixes["HK"]
        if s.endswith(sfx):
            return symbol[: -len(sfx)].strip()
    return symbol.strip()


def is_fetchable(symbol: str, market: str, asset_type: str) -> bool:
    """判断该标的是否可以走在线行情接口。"""
    if not symbol:
        return False
    core = strip_market_suffix(symbol, market)
    if core.upper() in NON_FETCHABLE_SYMBOLS:
        return False
    return True


def skip_reason(symbol: str, market: str, asset_type: str) -> Optional[str]:
    """返回无法拉取的原因；None 表示可以拉取。"""
    if not symbol:
        return "代码为空"
    core = strip_market_suffix(symbol, market)
    if core.upper() in NON_FETCHABLE_SYMBOLS:
        return f"{core} 为非行情标的（CASH/CUSTODY/INTEREST）"
    if asset_type.lower() == "option":
        return "美式期权历史行情暂不支持在线拉取"
    if market not in ("US", "HK", "A_SHARE"):
        return f"暂不支持市场 {market}"
    return None


def parse_us_option_symbol(symbol: str) -> Optional[Tuple[str, str, str, float]]:
    """解析美式期权代码，如 AAOI 260424C195 -> (underlying, expiry yyyymmdd, cp, strike)。

    返回 None 表示无法解析。
    """
    parts = symbol.strip().split()
    if len(parts) < 2:
        return None
    underlying = parts[0].strip().upper()
    occ = parts[-1].strip().upper()
    # OCC 格式: [A-Z]{6}\d{6}[CP]\d{8} 或 6位根码 + 6位日期 + C/P + 8位行权价
    if len(occ) < 15:
        return None
    root = occ[:6].rstrip()
    expiry = occ[6:12]
    cp = occ[12]
    strike_str = occ[13:]
    if cp not in ("C", "P"):
        return None
    try:
        strike = int(strike_str) / 1000.0
    except ValueError:
        return None
    return underlying, expiry, cp, strike


def is_us_option(symbol: str, asset_type: str) -> bool:
    """判断是否为美式期权代码。"""
    if asset_type.lower() == "option":
        return True
    if len(symbol.split()) >= 2 and parse_us_option_symbol(symbol):
        return True
    return False


def suggest_source(market: str, asset_type: str) -> Optional[str]:
    """根据市场和资产类型推荐最适合的在线数据源。"""
    if asset_type.lower() == "option":
        return None
    if market not in ("US", "HK", "A_SHARE"):
        return None
    if market in ("US", "HK"):
        return "yahoo"
    return "akshare"
