# 行情数据源能力矩阵与验证记录

本文记录本地行情适配器及 `stock-sdk` 的实际验证结果与当前路由。它不是供应商能力声明，也不代表任何未列明环境、账户权限或发布版本已经可用。

2026-07-14 已将 `stock-sdk@2.4.0` 设为 A／港／美股票实时源；Massive 现作为 Web 美股股票/个股期权未复权日 K及公司行动主源，stock-sdk 与 MarketData.app 按能力回退。iTick 和 Twelve Data 已从应用代码、设置、配置和本地密钥管理移除。Android 仍使用原生行情链路。

## 测试范围与判定

- 测试时间：2026-07-14（Asia/Shanghai）。PWA 结果来自生产式预览的 Chromium Desktop Chrome；manifest 已加载且 Service Worker 为 `activated`。Android `NativeMarket` 结果不能替代本节 PWA 结论。
- iTick、Twelve Data 和 MarketData.app 使用了本地提供的测试 Key；本文不保存 Key、请求凭据或真实备份内容。
- 快照成功指返回目标标的且价格为正的有限数。日 K 成功指返回非空、包含目标区间内数据、日期范围正确，并且 OHLC 合法（`low ≤ open/close ≤ high`）。
- 日 K 若涉及账本估值，必须明确记录复权口径；本轮 `stock-sdk` A／港日 K 使用不复权（`adjust: ''`，CLI 对应 `--adjust none`）。
- CORS、网络或解析异常、HTTP 成功但无业务数据、空数组、目标日期缺失、范围外数据与非法 OHLC 都是失败。失败结果不得写入缓存，也不得覆盖已有有效缓存。

状态说明：**通过** 表示本次 PWA 实测可用；**失败** 表示已实测但不满足写缓存条件；**不适用** 表示不应由该源承担该能力；**未测** 表示本轮没有实际 PWA 结论。

## 统一能力矩阵（PWA 实测）

| 数据源 | Key / 测试前提 | `quote.cn` | `quote.hk` | `quote.us` | `history.cn` | `history.hk` | `history.us` | `option.us` | CORS / 当前可用性 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| iTick（已移除） | 历史本地 Key 验证 | 通过：600519 | 失败：港股空数据 | 通过：AAPL | 通过 | 失败 | 通过 | 未测 | 仅保留历史验证结论；不再注册、配置或回退 |
| Twelve Data（已移除） | 历史本地 Key / 当前套餐 | 失败：套餐拒绝 | 失败：Pro 套餐限制 | 通过：AAPL | 失败 | 失败 | 通过 | 未测 | 仅保留历史验证结论；不再注册、配置或回退 |
| MarketData.app | 本地 Key；**仅 Web `option.us`** | 不适用 | 不适用 | 不适用（已禁用股票路由） | 不适用 | 不适用 | 不适用（已禁用股票路由） | **通过**：AAPL 个股期权快照及日 K，HTTP 203 且 `s=ok` | Web 期权唯一正式源；不作为股票回退 |
| stock-sdk 2.4.0 | 无 Key；股票唯一正式 provider | **通过**：600519、000858 | **通过**：07709 | **通过**：AAPL、SPY、QQQ | **通过**：600519，未复权 | **通过**：07709，未复权 | **通过**：AAPL、SPY、QQQ 各 15 根 | 不适用 | PWA 仍需按单次 CORS 失败显示失败且保留缓存；Android 经 NativeMarket |
| Massive Stocks API | 本机 Key；Web 美股历史主源及公司行动 | 不适用 | 不适用 | **套餐限制**：快照 403 | 不适用 | 不适用 | **通过**：AAPL 未复权日 K | 个股期权日 K通过；实时快照套餐限制 | 美股历史主源；stock-sdk/MarketData.app 作为回退 |

“通过”仅对应上述代表性标的、测试日期和当前权限；它不是同市场全部证券的覆盖承诺。iTick 及 Twelve Data 的 `option.us` 未在本轮验证，不能据此作为期权候选源。

## Massive 扩展能力（PWA 实测）

2026-07-17 使用本机密钥在 PWA 可访问的 API 请求上验证。报告只保存状态和样本数量，不保存密钥、请求 URL 或原始响应。

| 能力 | 当前端点 | 代表性输入 | 实测结果 | 当前产品结论 |
| --- | --- | --- | --- | --- |
| `metadata.us` | `/v3/reference/tickers/{ticker}` | AAPL | **通过**：返回代码、正式名称、市场、交易所、币种等资料 | 作为美股证券名称候选来源 |
| `history.us.raw` | `/v2/aggs/ticker/{ticker}/range/...` | AAPL，2026-06-01 至 2026-06-05，`adjusted=false` | **通过**：5 根，OHLC 与日期有效 | Web 美股股票历史主源 |
| `split.us` | `/stocks/v1/splits` | SNXX | **通过**：2026-06-03，`1 → 8`；当前端点已替代弃用的 `/v3/reference/splits` | Massive 当前正式用途 |
| `dividend.us` | `/stocks/v1/dividends` | AAPL | **通过**：返回除息日、派息日、金额、频率和调整因子 | 可作为分红资料候选；暂不自动导入分红流水 |
| `calendar.us` | `/v1/marketstatus/now`、`/v1/marketstatus/upcoming` | 当前市场状态与未来休市日 | **通过**：返回市场状态、交易所状态、服务器时间及休市日列表 | 可作为交易日历候选；暂不替代现有日历源 |
| `option.us.contracts` | `/v3/reference/options/contracts` | AAPL，limit=1 | **通过**：返回期权代码、看涨/看跌、到期日、行权价、合约乘数等 | 作为期权历史任务的合约资料来源 |
| `option.us.history` | `/v2/aggs/ticker/{optionTicker}/range/...` | AAPL 期权合约，2026-07-14 至 2026-07-16 | **通过**：返回有效期权 OHLC 日 K | Web 个股期权历史主源，MarketData.app 回退 |
| `quote.us.snapshot` | `/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}` | AAPL | **套餐限制**：403 | 不纳入当前实时行情路由 |
| `option.us.snapshot` | `/v3/snapshot/options/{underlying}/{contract}` | AAPL 期权合约 | **套餐限制**：403 | 不纳入当前实时期权路由 |

Massive 的历史日 K响应包含 `o/h/l/c/v/vw/t`，可映射到本地未复权日 K缓存；公司行动响应包含 `execution_date`、`split_from`、`split_to` 和调整因子。API 对 `http://127.0.0.1:4173` 返回允许来源，PWA 请求可跨域访问。快照 403 是当前套餐权限结果，不应归类为 CORS 或网络故障。

### 修复后定向 PWA 重测

2026-07-14 在同一生产式 Chromium PWA 预览中仅重测受影响的 `quote.cn`：manifest 存在、Service Worker 为 `activated`，`600519` 与 `000858` 均返回有效快照，结果为 `success`。本次没有重复运行此前已通过的其他 stock-sdk 能力。

随后在升级到 `stock-sdk@2.4.0` 后单独重测 `history.us`：manifest 存在、Service Worker 为 `activated`；AAPL、SPY、QQQ 均返回 15 根不复权日 K，结果为 `success`。这与官方在线平台支持 SPY 的结果一致。之后在同一预览服务中连续运行完整矩阵时，Eastmoney 偶发 `Failed to fetch`（按规则记录为 `cors_error`）；因此 2.4.0 已证明 SPY 的实际 PWA 可达性，但尚未满足“连续三次无 CORS”这一发布前门槛。

Twelve Data 港股格式化已改为四位纯数字代码（`7709.HK` → `7709`），并在 PWA 实测中确认代码已被识别；接口返回“需要 Pro/Venture 套餐”，因此当前权限下仍不能写入行情缓存。

### 正式路由实现后的冒烟

- Web：当前提交重新执行 production PWA 探针构建，并在独立 Chromium PWA 预览中通过 `quote.cn`（600519、000858 的 exchange-prefixed 路径）。已通过的港／美快照及三市场日 K 样本未重复执行。完整远端矩阵不作为单次 CI 通过条件：它在连续请求时可能长时间等待或发生 Eastmoney CORS，应用会将该次能力标记失败、保留有效缓存并提供重试。
- Android：使用 JDK 21 完成 Debug 构建并安装到 `sdk_gphone16k_x86_64` 模拟器。通过实际 WebView 的 `NativeMarket` 插件分别请求 `sh600519`、`hk00700`、`usAAPL`，均为 HTTP 200 且响应非空。该结果验证 Android 原生股票传输；不替代上述 PWA 结论。该模拟器当次请求 Yahoo 期权 chart 时 DNS 无法解析 `fc.yahoo.com`，所以 `option.us` Android 实测为网络失败、可重试，**不标记为通过**。

## 关键兼容性与失败证据

| 数据源 | 已验证结果 | 限制 / 解释 |
| --- | --- | --- |
| iTick | A 股和美国股票快照、日 K 返回有效业务数据 | 港股请求虽返回 HTTP 200 与业务成功码，但 `data` 缺失或为空，必须视为失败，不能写缓存。 |
| Twelve Data | 美国股票 AAPL 快照与日 K 正常返回 | A 股 600519 被当前套餐限制；港股代码格式修复后可被识别，但 7709 的快照和日 K 均被当前 Pro/Venture 套餐限制。 |
| MarketData.app | AAPL 股票快照、日 K，以及代表性 AAPL 个股期权快照、日 K 均满足业务成功条件 | API 的 HTTP 203 在当前适配器中是可接受的响应；必须同时检查业务字段 `s=ok` 和有效数据，不能只按 HTTP 状态误判。其市场范围不与境内 ETF、指数、商品或中金所期权混用。 |
| stock-sdk | 港美快照及 A／港／美不复权日 K 在 PWA 返回有效数据 | A 股快照旧失败由探针编码错误造成；修复后 600519、000858 在 Chromium PWA 均通过。美股历史失败的根因是本地 `2.3.0` 直接拼接 `105.<ticker>`，绕过了代码目录解析；升级到 `2.4.0` 后改用裸代码解析，AAPL、SPY、QQQ 均通过。 |

### 港股代码规范化

导入数据中可出现 `7709.HK`。Twelve Data 港股接口使用四位纯数字交易所代码；修复前适配器会追加 `.HK`，对 `7709.HK` 形成 `7709.HK.HK`。修复后统一传 `7709`，PWA 重测确认代码已被接口识别，但当前 Key 对该标的返回 Pro/Venture 套餐限制。

因此，港股结果应分别记录“代码格式化缺陷已修复”和“当前权限限制”两层事实，不能把格式修复等同于能力通过。iTick 对 `07709` 与 `7709.HK` 同样未返回有效港股业务数据。

### 美股快照与历史 K 线的接口差异

`quote.us` 使用腾讯快照接口，AAPL、SPY、QQQ 均可返回报价；`history.us` 使用 Eastmoney 美股历史 K 线接口。`stock-sdk@2.3.0` 的探针错误地把裸代码改成 `105.<ticker>`，其中 `105.SPY` 不在当时本地代码目录中，导致空数组；`stock-sdk@2.4.0` 增加了代码目录解析，裸传 `SPY` 可解析到有效 secid。故 quote/history 差异来自版本和调用方式，不能据旧版结果推断 stock-sdk 不支持 SPY。

## stock-sdk 专项验证规则与原始结果

- 测试依赖固定为 `stock-sdk@2.4.0`；2.3.0 的美股历史 secid 拼接缺陷已不再使用。
- 探针区间为 `20260622` 到 `20260713`；A／港日 K 复权口径为 `none`。
- `option.us` 明确不由 stock-sdk 处理，仍由 MarketData.app 承担美股个股期权日 K。

| 能力 | Node CLI 冒烟 | PWA（Chromium） | 当前结论 |
| --- | --- | --- | --- |
| `quote.cn` | 成功（600519） | **成功（600519、000858；已加 sh/sz 前缀）** | 可继续观察 |
| `quote.hk` | 成功（07709） | 成功（07709） | 可继续观察 |
| `quote.us` | 成功（AAPL） | 成功（AAPL／SPY／QQQ） | 可继续观察 |
| `history.cn` | 成功（600519，未复权） | 成功（600519，16 根） | 可继续观察 |
| `history.hk` | 成功（07709，未复权） | 成功（07709，15 根） | 可继续观察 |
| `history.us` | 裸代码解析后 AAPL、SPY、QQQ 各 15 根 | **成功**：AAPL、SPY、QQQ 各 15 根 | 仍需连续三次 PWA 冒烟后再评估默认优先级 |
| `option.us` | 不适用 | 不适用 | 继续使用 MarketData.app |

## stock-sdk 期权能力探索（PWA 与 Node）

官方 API 将 `sdk.options` 分为股指、ETF、商品、中金所和期权龙虎榜；这与美股个股期权是不同能力域。本轮在 `stock-sdk@2.4.0` 中使用同一组代表性输入分别做 Node 与 Chromium PWA 冒烟。PWA 运行时 manifest 存在、Service Worker 为 `activated`。

| 能力 | 代表性输入 | Node 结果 | PWA 结果 | 当前结论 |
| --- | --- | --- | --- | --- |
| `option.cn.etf` | `options.etf.dailyKline('10004336')` | 通过，132 根日 K | 通过，132 根 | 可作为境内 ETF 期权日 K 的测试候选；仍需验证合约代码发现与到期月份流程 |
| `option.cn.index` | `options.index.kline('io2504C3600')` | 通过，56 根日 K；`index.spot('io', ...)` 返回 calls/puts | 通过，56 根 | 可作为股指期权历史 K 线候选，不等同于中金所实时行情 |
| `option.cn.commodity` | `options.commodity.spot('au', '2610')` | 空 calls/puts，失败 | `empty_data`，失败 | 当前样本未得到业务数据；不能写缓存或据此宣称商品期权可用。非法品种（如 `rb`）会明确返回 `INVALID_ARGUMENT` |
| `option.cn.cffex` | `options.cffex.quotes()` | 通过，690 个报价；包含 `IO2607-C-4700` | 通过，690 个报价 | 中金所期权实时行情能力单独成立，不能与 ETF／商品接口混用 |
| `option.cn.lhb` | `options.lhb('510050', '2026-07-13')` | 通过，21 条 | 通过，21 条 | 期权龙虎榜可用，但它是统计数据，不是个别合约日 K |
| `option.us` | 美股个股期权 | SDK 无对应 API | 不适用 | 继续固定由 MarketData.app 承担 |

补充限制：Node 中 `options.etf.minute('10004336')` 返回空数组，说明 ETF 期权日 K 示例代码不能直接当作分钟接口的有效合约代码；分钟能力需要先通过月份／合约目录得到真实期权合约后再测。所有空数组、CORS、解析异常均按失败处理，不覆盖已有缓存。

## 当前正式路由

- 股票 `quote.cn`／`quote.hk`／`quote.us`：由 `stock-sdk` 提供实时行情；A／港股历史仍由 `stock-sdk` 提供。Web 美股股票 `history.us` 由 Massive 优先，stock-sdk 作为回退。所有日 K 始终使用未复权口径并写入 `adjustmentMode: raw`；账本估值只读未复权价格。
- Web 美股个股期权历史 `option.us` 由 Massive 优先，MarketData.app 作为回退；期权实时行情仍由 MarketData.app。Android 美股个股期权继续使用 Yahoo/NativeMarket。
- Massive、stock-sdk 和 MarketData.app 的确定性空数据、权限拒绝或不支持结果会记录已尝试来源并进入回退链；网络、超时和限流仍按来源退避重试。所有来源耗尽后才标记“暂不支持”。
- 境内 ETF、指数、商品和中金所期权与美股个股期权分开建模；stock-sdk 的对应能力保持探针/文档用途。

## 运行方式与实装门槛

```text
npm run build:market-probe --workspace @recoder/web
npx playwright test --config stock-sdk-pwa.config.ts
npx playwright test --config stock-sdk-pwa.config.ts src/e2e/stock-sdk-options-pwa.spec.ts
```

探针产物只用于验证，不应把 `samples/` 或真实用户数据加入提交。

当前实现已使用 stock-sdk 作为股票默认源；发布前仍应持续在 PWA 中对代表性标的连续三次独立运行，并单独记录 CORS 失败：

- `quote.cn`：600519；
- `history.cn`：600519；
- `history.hk`：07709；
- `history.us`：AAPL、SPY、QQQ；
- 所有日 K 仍必须是不复权且通过日期、非空和 OHLC 校验。

即使通过，stock-sdk 也不会用于美股个股期权；PWA 与 Android 的能力结果仍须分别记录，Android NativeMarket 成功不能证明浏览器 PWA 可用。

参考：[stock-sdk 浏览器使用说明](https://stock-sdk.linkdiary.cn/guide/browser)、[K 线 API](https://stock-sdk.linkdiary.cn/api/kline)、[npm 2.4.0](https://www.npmjs.com/package/stock-sdk)。
