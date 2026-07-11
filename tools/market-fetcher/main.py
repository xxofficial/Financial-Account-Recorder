import os
import sys
import traceback


_LOG_PATH = os.path.expanduser("~/recoder-market-fetcher-error.log")


def _global_excepthook(exc_type, exc_value, exc_tb):
    """捕获所有未处理异常，写到 error.log 方便排查。"""
    try:
        with open(_LOG_PATH, "w", encoding="utf-8") as f:
            traceback.print_exception(exc_type, exc_value, exc_tb, file=f)
    except Exception:
        pass
    # 仍打印到 stderr，方便控制台/调试模式查看
    traceback.print_exception(exc_type, exc_value, exc_tb)


sys.excepthook = _global_excepthook


def _run_smoke_test():
    """无头冒烟测试：验证添加任务、导入缺失清单、拉取、导出缓存包完整流程。"""
    import json
    import tempfile
    from collections import deque

    os.environ["QT_QPA_PLATFORM"] = "offscreen"

    from PyQt6.QtWidgets import QApplication
    from PyQt6.QtCore import QEventLoop, QTimer

    from market_fetcher.gui import MainWindow
    from market_fetcher.models import HistoricalBar
    from market_fetcher.cache_reader import read_missing_package
    from market_fetcher.cache_writer import write_cache_package_to_file
    import market_fetcher.fetcher_router as fetcher_router

    class FakeFetcher:
        def fetch_bars(self, symbol, market, asset_type, start_date, end_date):
            return [
                HistoricalBar(
                    symbol=symbol,
                    market=market,
                    asset_type=asset_type,
                    trade_date="2024-01-02",
                    open=149.0,
                    high=151.0,
                    low=148.0,
                    close=150.0,
                    volume=1_000_000,
                    provider_id="test",
                    source_id="test",
                    source_name="Test Source",
                    source_type="test",
                    adjusted_mode="unadjusted",
                )
            ]

    fetcher_router.get_fetcher = lambda _source_id: FakeFetcher()

    app = QApplication([])
    window = MainWindow()
    window.show()

    errors = deque()

    def collect_errors():
        # 复用错误信号收集日志
        window.worker.error.connect(lambda sym, msg: errors.append((sym, msg)))

    # 1. 手动添加任务
    window.symbol_input.setText("AAPL")
    window._add_task()
    assert len(window.tasks) == 1, "手动添加任务失败"
    print("[smoke] add task ok")

    # 2. 导入缺失清单
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(
            {
                "version": "missing-market-data-v1",
                "items": [
                    {
                        "securityKey": "US:TSLA",
                        "symbol": "TSLA",
                        "market": "US",
                        "assetType": "stock",
                        "requiredFromDate": "2024-01-01",
                        "requiredToDate": "2024-01-31",
                        "preferredFetchFromDate": "2024-01-01",
                        "preferredFetchToDate": "2024-01-31",
                    }
                ],
            },
            f,
        )
        missing_path = f.name

    items = read_missing_package(missing_path)
    for item in items:
        window._add_task(
            {
                "source": window.source_combo.currentText(),
                "market": item.get("market", "US"),
                "asset_type": item.get("assetType", "stock"),
                "symbol": item.get("symbol", ""),
                "start_date": item.get(
                    "preferredFetchFromDate", item.get("requiredFromDate", "")
                ),
                "end_date": item.get(
                    "preferredFetchToDate", item.get("requiredToDate", "")
                ),
            }
        )
    assert len(window.tasks) == 2, "导入缺失清单后任务数不对"
    print("[smoke] import missing list ok")

    # 3. 开始拉取
    window._start_fetch()
    collect_errors()

    loop = QEventLoop()
    window.worker.finished_all.connect(loop.quit)
    QTimer.singleShot(10000, loop.quit)  # 10 秒保险超时
    loop.exec()

    assert len(window.fetched_bars) > 0, "没有拉取到任何 K 线"
    print(f"[smoke] fetch ok, bars={len(window.fetched_bars)}")
    if errors:
        print(f"[smoke] worker errors: {list(errors)}")
        raise AssertionError("拉取过程中出现错误")

    # 4. 导出缓存包
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        export_path = f.name
    write_cache_package_to_file(window.fetched_bars, export_path)
    with open(export_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data.get("version") == "market-cache-v1", "缓存包版本不对"
    assert len(data.get("bars", [])) == len(window.fetched_bars), "缓存包 bar 数量不对"
    assert len(data.get("coverage", [])) > 0, "缓存包 coverage 为空"
    print("[smoke] export cache ok")

    # 清理
    os.remove(missing_path)
    os.remove(export_path)

    print("SMOKE_TEST_OK")
    sys.exit(0)


def main():
    if "--smoke-test" in sys.argv:
        _run_smoke_test()

    from PyQt6.QtWidgets import QApplication
    from market_fetcher.gui import MainWindow

    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
