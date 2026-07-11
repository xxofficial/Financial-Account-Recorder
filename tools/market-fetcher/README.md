# Recoder 行情预取工具

从 Yahoo Finance / Sina / AkShare 预取历史行情，生成 `market-cache-v1.json` 供主应用导入。

## 快速使用

1. 启动 GUI：
   ```bash
   python main.py
   ```
2. 点击「导入缺失清单」，选择主应用导出的 `missing-market-data-v1-*.json`。
3. 点击「开始拉取」。
4. 拉取完成后点击「导出缓存包」，生成 `market-cache-v1.json`。

## 数据源与市场

导入缺失清单时会自动按市场选择数据源，并在失败时自动回退：

| 市场 | 资产类型 | 数据源（优先级） | 说明 |
|------|----------|-----------------|------|
| US | 股票 | Yahoo Finance | 失败后无其他在线源可用 |
| US | 期权 | 跳过 | 美式期权历史行情暂不支持直接拉取 |
| HK | 股票 | Yahoo Finance → AkShare | Yahoo 失败会自动回退到 AkShare |
| A_SHARE | 股票/期权 | AkShare → Sina | AkShare 失败会自动回退到 Sina |
| 任意 | CASH / CUSTODY / INTEREST | 跳过 | 非行情标的，无需拉取 |

拉取时会进行指数退避重试：连接/超时/限流类错误最多重试 3 次，间隔 1s / 2s / 4s。

## 常见问题

### 全部拉取失败

1. 检查网络是否能访问 Yahoo Finance / AkShare 对应接口。
2. 检查是否被限流：Yahoo Finance 对高频请求会返回 `Too Many Requests`。工具已内置 0.5 秒任务间隔，必要时可降低并发或稍后再试。
3. 检查日志中的错误信息，确认是符号格式问题还是网络问题。

### 期权为什么被跳过

当前工具只支持股票历史行情。美式期权（如 `AAOI 260424C195`）无法通过 Yahoo Finance 的 `history` 接口直接获取，导入时会被明确跳过并记录原因。

### 手动添加任务

来源下拉框仅对手动输入的任务生效。导入缺失清单时会自动根据市场选择最合适的数据源。

## 打包

```bash
python build.py --debug --onedir
```

`--debug` 保留控制台窗口，`--onedir` 输出目录而非单文件，兼容性更好。

## 测试

```bash
python main.py --smoke-test
```
