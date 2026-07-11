"""PyQt6 桌面 GUI。"""
import json
import time
from typing import List, Dict, Any, Optional
from datetime import datetime

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QLineEdit, QComboBox, QTableWidget, QTableWidgetItem,
    QFileDialog, QPlainTextEdit, QGroupBox, QProgressBar, QMessageBox
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal

from market_fetcher.models import HistoricalBar
import market_fetcher.fetcher_router as fetcher_router
from market_fetcher.cache_writer import build_cache_package, write_cache_package_to_file
from market_fetcher.cache_reader import read_missing_package
from market_fetcher.symbol_utils import suggest_source, skip_reason


class FetchWorker(QThread):
    bar_fetched = pyqtSignal(object)
    task_done = pyqtSignal(str, int)
    error = pyqtSignal(str, str)
    progress = pyqtSignal(int, int)
    finished_all = pyqtSignal()

    def __init__(self, tasks: List[Dict[str, Any]]):
        super().__init__()
        self.tasks = tasks
        self._running = True

    def _is_retryable(self, exc: Exception) -> bool:
        """判断是否为可重试的网络/连接类错误。"""
        msg = str(exc).lower()
        keywords = [
            "connection", "remote", "timeout", "timed out", "rate limit",
            "too many requests", "network", "ssl", "abort", "reset", "refused",
        ]
        return any(k in msg for k in keywords)

    def _fetch_with_retry(self, source: str, task: Dict[str, Any], max_retries: int = 3) -> List[HistoricalBar]:
        """对单个数据源进行指数退避重试。"""
        fetcher = fetcher_router.get_fetcher(source)
        last_exc: Optional[Exception] = None
        for attempt in range(max_retries):
            try:
                return fetcher.fetch_bars(
                    task["symbol"],
                    task["market"],
                    task["asset_type"],
                    task["start_date"],
                    task["end_date"],
                )
            except Exception as e:
                last_exc = e
                if not self._is_retryable(e) or attempt == max_retries - 1:
                    raise
                # 指数退避：1s, 2s, 4s
                time.sleep(2 ** attempt)
        # 理论上不会执行到这里
        if last_exc:
            raise last_exc
        return []

    def run(self):
        total = len(self.tasks)
        for idx, task in enumerate(self.tasks):
            if not self._running:
                break
            self.progress.emit(idx + 1, total)

            sources = fetcher_router.resolve_sources(task["market"], task["source"])
            bars: List[HistoricalBar] = []
            tried = []
            last_error = ""

            for source in sources:
                if not self._running:
                    break
                tried.append(source)
                try:
                    bars = self._fetch_with_retry(source, task)
                    if bars:
                        break
                    last_error = f"via {source}: 返回 0 条 K 线"
                except Exception as e:
                    last_error = f"via {source}: {e}"
                    # 失败后在回退前等待一下，避免对下一个数据源也造成压力
                    if self._is_retryable(e):
                        time.sleep(1.5)

            if bars:
                for bar in bars:
                    self.bar_fetched.emit(bar)
                self.task_done.emit(task["symbol"], len(bars))
            else:
                tried_str = ", ".join(tried)
                self.error.emit(task["symbol"], f"已尝试 {tried_str}，均失败: {last_error}")

            # 在任务之间稍作等待，避免对数据源造成过大压力或触发限流
            time.sleep(0.5)
        self.finished_all.emit()

    def stop(self):
        self._running = False


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Recoder 行情预取工具")
        self.setMinimumSize(1000, 700)
        self.fetched_bars: List[HistoricalBar] = []
        self.tasks: List[Dict[str, Any]] = []
        self.worker: Optional[FetchWorker] = None
        self._fetch_errors: List[str] = []
        self._init_ui()

    def _init_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)

        # Header
        header = QLabel("Recoder 行情预取工具")
        header.setStyleSheet("font-size: 20px; font-weight: bold;")
        layout.addWidget(header)
        sub = QLabel("从 Yahoo / Sina / AkShare 预取历史行情，生成 market-cache-v1.json")
        sub.setStyleSheet("color: #666;")
        layout.addWidget(sub)

        # Add task form
        form_group = QGroupBox("添加任务")
        form_layout = QHBoxLayout(form_group)
        form_layout.setSpacing(8)

        self.source_combo = QComboBox()
        self.source_combo.addItems(["yahoo", "sina", "akshare"])
        form_layout.addWidget(QLabel("数据源"))
        form_layout.addWidget(self.source_combo)

        self.market_combo = QComboBox()
        self.market_combo.addItems(["US", "HK", "A_SHARE"])
        form_layout.addWidget(QLabel("市场"))
        form_layout.addWidget(self.market_combo)

        self.asset_combo = QComboBox()
        self.asset_combo.addItems(["stock", "option"])
        form_layout.addWidget(QLabel("资产类型"))
        form_layout.addWidget(self.asset_combo)

        self.symbol_input = QLineEdit()
        self.symbol_input.setPlaceholderText("AAPL")
        form_layout.addWidget(QLabel("代码"))
        form_layout.addWidget(self.symbol_input)

        self.start_date_input = QLineEdit()
        self.start_date_input.setPlaceholderText("2024-01-01")
        form_layout.addWidget(QLabel("开始"))
        form_layout.addWidget(self.start_date_input)

        self.end_date_input = QLineEdit()
        self.end_date_input.setPlaceholderText("2024-12-31")
        form_layout.addWidget(QLabel("结束"))
        form_layout.addWidget(self.end_date_input)

        self.add_btn = QPushButton("添加")
        self.add_btn.clicked.connect(lambda checked: self._add_task())
        form_layout.addWidget(self.add_btn)
        form_layout.addStretch()

        layout.addWidget(form_group)

        # Task table
        self.table = QTableWidget()
        self.table.setColumnCount(6)
        self.table.setHorizontalHeaderLabels(["数据源", "市场", "资产", "代码", "开始", "结束"])
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.table)

        # Actions
        action_layout = QHBoxLayout()
        self.load_btn = QPushButton("导入缺失清单")
        self.load_btn.clicked.connect(self._load_missing)
        action_layout.addWidget(self.load_btn)

        self.fetch_btn = QPushButton("开始拉取")
        self.fetch_btn.clicked.connect(self._start_fetch)
        action_layout.addWidget(self.fetch_btn)

        self.stop_btn = QPushButton("停止")
        self.stop_btn.clicked.connect(self._stop_fetch)
        self.stop_btn.setEnabled(False)
        action_layout.addWidget(self.stop_btn)

        self.clear_btn = QPushButton("清空任务")
        self.clear_btn.clicked.connect(self._clear_tasks)
        action_layout.addWidget(self.clear_btn)

        self.export_btn = QPushButton("导出缓存包")
        self.export_btn.clicked.connect(self._export_cache)
        self.export_btn.setEnabled(False)
        action_layout.addWidget(self.export_btn)

        action_layout.addStretch()
        layout.addLayout(action_layout)

        # Progress
        self.progress = QProgressBar()
        self.progress.setValue(0)
        layout.addWidget(self.progress)

        # Log
        log_group = QGroupBox("日志")
        log_layout = QVBoxLayout(log_group)
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        log_layout.addWidget(self.log)
        layout.addWidget(log_group, stretch=1)

        # Default dates
        self.start_date_input.setText("2024-01-01")
        self.end_date_input.setText(datetime.now().strftime("%Y-%m-%d"))

    def _log(self, msg: str):
        self.log.appendPlainText(msg)

    def _add_task(self, task: Optional[Dict[str, Any]] = None):
        if task is None:
            symbol = self.symbol_input.text().strip()
            if not symbol:
                QMessageBox.warning(self, "提示", "请输入标的代码")
                return
            task = {
                "source": self.source_combo.currentText(),
                "market": self.market_combo.currentText(),
                "asset_type": self.asset_combo.currentText(),
                "symbol": symbol,
                "start_date": self.start_date_input.text().strip() or "2024-01-01",
                "end_date": self.end_date_input.text().strip() or datetime.now().strftime("%Y-%m-%d"),
            }
        self.tasks.append(task)
        self._refresh_table()
        self._log(f"已添加任务: {task['symbol']} ({task['market']} via {task['source']})")

    def _refresh_table(self):
        self.table.setRowCount(len(self.tasks))
        for i, task in enumerate(self.tasks):
            self.table.setItem(i, 0, QTableWidgetItem(task["source"]))
            self.table.setItem(i, 1, QTableWidgetItem(task["market"]))
            self.table.setItem(i, 2, QTableWidgetItem(task["asset_type"]))
            self.table.setItem(i, 3, QTableWidgetItem(task["symbol"]))
            self.table.setItem(i, 4, QTableWidgetItem(task["start_date"]))
            self.table.setItem(i, 5, QTableWidgetItem(task["end_date"]))
        self.table.resizeColumnsToContents()

    def _load_missing(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 missing-market-data-v1.json", "", "JSON (*.json)"
        )
        if not path:
            return
        try:
            items = read_missing_package(path)
            skipped = []
            added = 0
            for item in items:
                symbol = item.get("symbol", "")
                market = item.get("market", "US")
                asset_type = item.get("assetType", "stock")
                reason = skip_reason(symbol, market, asset_type)
                if reason:
                    skipped.append(f"{symbol}: {reason}")
                    continue
                # 按市场自动推荐数据源，不再盲目使用当前下拉框
                source = suggest_source(market, asset_type)
                if source is None:
                    skipped.append(f"{symbol}: 无可用数据源")
                    continue
                self._add_task({
                    "source": source,
                    "market": market,
                    "asset_type": asset_type,
                    "symbol": symbol,
                    "start_date": item.get("preferredFetchFromDate", item.get("requiredFromDate", "")),
                    "end_date": item.get("preferredFetchToDate", item.get("requiredToDate", "")),
                })
                added += 1
            self._log(f"已从 {path} 导入 {added} 个缺失任务")
            if skipped:
                self._log(f"跳过 {len(skipped)} 个不支持在线拉取的条目:")
                for s in skipped[:20]:
                    self._log(f"  - {s}")
                if len(skipped) > 20:
                    self._log(f"  ... 还有 {len(skipped) - 20} 条")
        except Exception as e:
            QMessageBox.critical(self, "导入失败", str(e))

    def _start_fetch(self):
        if not self.tasks:
            QMessageBox.warning(self, "提示", "请先添加任务")
            return
        self.fetched_bars.clear()
        self._fetch_errors.clear()
        self.export_btn.setEnabled(False)
        self.fetch_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.progress.setValue(0)

        self.worker = FetchWorker(self.tasks)
        self.worker.bar_fetched.connect(self._on_bar_fetched)
        self.worker.task_done.connect(self._on_task_done)
        self.worker.error.connect(self._on_error)
        self.worker.progress.connect(self._on_progress)
        self.worker.finished_all.connect(self._on_finished)
        self.worker.start()
        self._log(f"开始拉取 {len(self.tasks)} 个任务...")

    def _stop_fetch(self):
        if self.worker:
            self.worker.stop()
            self.worker.wait(1000)
        self._log("已停止拉取")
        self._reset_fetch_buttons()

    def _on_bar_fetched(self, bar: HistoricalBar):
        self.fetched_bars.append(bar)

    def _on_task_done(self, symbol: str, count: int):
        self._log(f"{symbol}: 拉取到 {count} 条 K 线")

    def _on_error(self, symbol: str, msg: str):
        self._fetch_errors.append(f"{symbol}: {msg}")
        self._log(f"{symbol}: 错误 - {msg}")

    def _on_progress(self, current: int, total: int):
        self.progress.setMaximum(total)
        self.progress.setValue(current)

    def _on_finished(self):
        total = len(self.fetched_bars)
        errors = len(self._fetch_errors)
        self._log(f"全部完成，共 {total} 条 K 线，失败 {errors} 个任务")
        if errors:
            self._log(f"失败详情（前 20）:\n" + "\n".join(self._fetch_errors[:20]))
        self._reset_fetch_buttons()
        if self.fetched_bars:
            self.export_btn.setEnabled(True)

    def _reset_fetch_buttons(self):
        self.fetch_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)

    def _clear_tasks(self):
        self.tasks.clear()
        self._refresh_table()
        self.fetched_bars.clear()
        self.export_btn.setEnabled(False)
        self._log("已清空任务")

    def _export_cache(self):
        if not self.fetched_bars:
            QMessageBox.warning(self, "提示", "没有可导出的数据")
            return
        default_name = f"market-cache-v1-{datetime.now().strftime('%Y-%m-%d')}.json"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出缓存包", default_name, "JSON (*.json)"
        )
        if not path:
            return
        try:
            write_cache_package_to_file(self.fetched_bars, path)
            self._log(f"已导出缓存包: {path}")
            QMessageBox.information(self, "导出成功", f"缓存包已保存到:\n{path}")
        except Exception as e:
            QMessageBox.critical(self, "导出失败", str(e))


def run_app():
    app = QApplication([])
    window = MainWindow()
    window.show()
    app.exec()


if __name__ == "__main__":
    run_app()
