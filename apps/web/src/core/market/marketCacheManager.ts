import { db } from '../../db/localDb';
import { HistoricalBar, HistoricalCoverage, MarketWorkItem, Transaction } from '../../db/schema';
import {
  HistoricalBarImport,
  MarketCachePackageV1,
  MissingMarketDataPackageV1,
  marketCacheV1Schema,
  parseHistoricalBarImports,
} from '../../shared/schemas/marketCache';
import { HistoricalGapAnalyzer } from './HistoricalGapAnalyzer';
import { upsertMarketWorkItems } from './marketQueueManager';
import { MarketTaskExecutor } from './MarketTaskExecutor';
import { PortfolioCalculator } from '../portfolio/portfolioCalculator';

export interface ImportMarketCacheOptions {
  overwrite?: boolean;
}

export interface MarketCacheImportReport {
  totalInFile: number;
  valid: number;
  invalid: number;
  inserted: number;
  skipped: number;
  overwritten: number;
  invalidDetails: { row: number; reason: string }[];
  overwrittenDetails: {
    securityKey: string;
    tradeDate: string;
    oldProviderId?: string;
    oldSourceName?: string;
    oldFetchedAt?: number;
  }[];
}

const RESOLUTION = '1d' as const;

const MARKET_TIME_ZONES: Record<string, string> = {
  US: 'America/New_York',
  HK: 'Asia/Hong_Kong',
  A_SHARE: 'Asia/Shanghai',
};

/**
 * Return the calendar date that applies to a market, rather than the device's
 * UTC date. A range may end on a weekend or holiday; the provider simply
 * returns the last available trading-day bar within that range.
 */
export function marketTodayForHistoricalSync(market: string, referenceAt = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONES[market] ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function makeSecurityKey(symbol: string, market: string): string {
  return `${market}:${symbol}`;
}

function makeBarId(bar: Pick<HistoricalBar, 'market' | 'symbol' | 'assetType' | 'tradeDate'>): string {
  return `${bar.market}:${bar.symbol}:${bar.assetType}:${RESOLUTION}:${bar.tradeDate}`;
}

function makeDedupKey(securityKey: string, tradeDate: string): string {
  return `${securityKey}:${RESOLUTION}:${tradeDate}`;
}

const NON_QUOTABLE_SYMBOLS = new Set([
  'CASH', 'CUSTODY', 'INTEREST', 'FX', 'USD', 'CNY', 'HKD', 'JPY', 'EUR', 'GBP', 'AUD', 'CAD',
]);

const NON_QUOTABLE_TRADE_TYPES = new Set([
  'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT', 'TRANSFER_IN', 'INTEREST', 'TAX', 'FX_CONVERSION', 'OTHER', 'DIVIDEND',
]);

interface HistoricalRangeRequest {
  securityKey: string;
  symbol: string;
  market: string;
  assetType: 'stock' | 'option';
  fromDate: string;
  toDate: string;
}

/**
 * 从交易记录中提取需要行情数据的证券/期权，按标的聚合为单一历史区间请求。
 * 区间从首笔可报价交易日延伸到该市场本地的今天。
 * 过滤掉现金、利息、转账、外汇等非行情记录。
 */
function getHistoricalRangeRequestsFromTransactions(
  transactions: Transaction[],
  referenceAt = new Date(),
): HistoricalRangeRequest[] {
  // Reuse the same quantity semantics as the portfolio page (including
  // transfers, splits, options and short positions) when deciding whether a
  // security remains open today.
  const positions = new PortfolioCalculator().calculate(transactions, [], { usdToCny: 1, hkdToCny: 1 }).positions;
  const groups = new Map<
    string,
    { symbol: string; market: string; assetType: 'stock' | 'option'; dates: Set<string> }
  >();

  for (const tx of transactions) {
    if (!tx.symbol || !tx.market || !tx.tradeDate) continue;
    if (tx.market === 'CASH') continue;
    if (tx.assetType !== 'STOCK' && tx.assetType !== 'OPTION') continue;
    if (NON_QUOTABLE_TRADE_TYPES.has(tx.tradeType || '')) continue;
    const symbolUpper = tx.symbol.toUpperCase();
    if (NON_QUOTABLE_SYMBOLS.has(symbolUpper)) continue;

    const key = `${tx.market}:${tx.symbol}`;
    const existing = groups.get(key);
    if (existing) {
      existing.dates.add(tx.tradeDate);
    } else {
      groups.set(key, {
        symbol: tx.symbol,
        market: tx.market,
        assetType: tx.assetType.toLowerCase() as 'stock' | 'option',
        dates: new Set([tx.tradeDate]),
      });
    }
  }

  const requests: HistoricalRangeRequest[] = [];
  for (const [key, info] of groups) {
    const dates = Array.from(info.dates).sort();
    if (dates.length === 0) continue;
    requests.push({
      securityKey: key,
      symbol: info.symbol,
      market: info.market,
      assetType: info.assetType,
      fromDate: dates[0],
      toDate: Math.abs(positions[key]?.quantity ?? 0) > 1e-5
        ? marketTodayForHistoricalSync(info.market, referenceAt)
        : dates[dates.length - 1],
    });
  }

  return requests;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Returns only the portions of a required range that are not already covered
 * by a provider-confirmed successful request.  The coverage records are range
 * based deliberately: a weekday-only bar comparison cannot distinguish an
 * exchange holiday from an unfinished download.
 */
function subtractCoveredRanges(
  fromDate: string,
  toDate: string,
  coverage: Array<{ fromDate: string; toDate: string }>,
): Array<{ fromDate: string; toDate: string }> {
  const result: Array<{ fromDate: string; toDate: string }> = [];
  let cursor = fromDate;

  for (const item of coverage) {
    if (item.toDate < cursor || item.fromDate > toDate) continue;
    if (item.fromDate > cursor) {
      const end = addUtcDays(item.fromDate, -1);
      if (cursor <= end) result.push({ fromDate: cursor, toDate: end });
    }
    if (item.toDate >= cursor) cursor = addUtcDays(item.toDate, 1);
    if (cursor > toDate) break;
  }

  if (cursor <= toDate) result.push({ fromDate: cursor, toDate });
  return result;
}

function isGzipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.gz') || file.name.toLowerCase().endsWith('.json.gz');
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

async function decompressGzip(file: File): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 gzip 解压，请使用 .json 文件');
  }
  const buffer = await readFileAsArrayBuffer(file);
  const bytes = new Uint8Array(buffer);
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const output = await new Response(stream.readable).arrayBuffer();
  return new TextDecoder().decode(output);
}

async function readFileAsText(file: File): Promise<string> {
  if (isGzipFile(file)) {
    return decompressGzip(file);
  }
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

export async function compressGzip(text: string): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 gzip 压缩');
  }
  const bytes = new TextEncoder().encode(text);
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const output = await new Response(stream.readable).arrayBuffer();
  return new Blob([output], { type: 'application/gzip' });
}

export class MarketCacheManager {
  /**
   * 导出当前所有 historicalBars 与 historicalCoverage 为 market-cache-v1.json。
   */
  async exportMarketCache(): Promise<MarketCachePackageV1> {
    const bars = await db.historicalBars.toArray();
    const coverage = await db.historicalCoverage.toArray();

    return {
      version: 'market-cache-v1',
      generatedAt: new Date().toISOString(),
      generator: { name: 'recoder-web', version: '1.0.0' },
      bars: bars.map((b) => this.toImportBar(b)),
      coverage: coverage.map((c) => this.toImportCoverage(c)),
    };
  }

  /**
   * 导出 Blob（JSON 文本），可选 gzip 压缩。
   */
  async exportMarketCacheBlob(options?: { gzip?: boolean }): Promise<{ blob: Blob; fileName: string }> {
    const cache = await this.exportMarketCache();
    const text = JSON.stringify(cache, null, 2);
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `market-cache-v1-${dateStr}${options?.gzip ? '.json.gz' : '.json'}`;

    if (options?.gzip) {
      const gzipped = await compressGzip(text);
      return { blob: gzipped, fileName };
    }

    return { blob: new Blob([text], { type: 'application/json' }), fileName };
  }

  /**
   * 导入 market-cache-v1.json / .json.gz。
   */
  async importMarketCache(file: File, options?: ImportMarketCacheOptions): Promise<MarketCacheImportReport> {
    const overwrite = options?.overwrite ?? false;
    const report: MarketCacheImportReport = {
      totalInFile: 0,
      valid: 0,
      invalid: 0,
      inserted: 0,
      skipped: 0,
      overwritten: 0,
      invalidDetails: [],
      overwrittenDetails: [],
    };

    const content = await readFileAsText(file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('文件不是有效的 JSON');
    }

    const topLevel = marketCacheV1Schema.safeParse(parsed);
    if (!topLevel.success) {
      const reasons = topLevel.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
      throw new Error(`缓存包结构校验失败：${reasons.join('; ')}`);
    }

    const raw = parsed as { bars?: unknown[]; coverage?: unknown[] };
    const rawBars = Array.isArray(raw.bars) ? raw.bars : [];
    report.totalInFile = rawBars.length;

    const { valid, invalid } = parseHistoricalBarImports(rawBars);
    report.valid = valid.length;
    report.invalid = invalid.length;
    report.invalidDetails = invalid;

    if (valid.length === 0) {
      return report;
    }

    // 按 securityKey + resolution + tradeDate 去重（同一文件内先出现者优先）
    const dedupedBars: HistoricalBarImport[] = [];
    const seenDedupKeys = new Set<string>();
    for (const { bar } of valid) {
      const securityKey = makeSecurityKey(bar.symbol, bar.market);
      const dedupKey = makeDedupKey(securityKey, bar.tradeDate);
      if (seenDedupKeys.has(dedupKey)) continue;
      seenDedupKeys.add(dedupKey);
      dedupedBars.push(bar);
    }

    // 按 securityKey 分组，准备查询现有 bar
    const barsBySecurityKey = new Map<string, HistoricalBarImport[]>();
    for (const bar of dedupedBars) {
      const key = makeSecurityKey(bar.symbol, bar.market);
      const list = barsBySecurityKey.get(key) ?? [];
      list.push(bar);
      barsBySecurityKey.set(key, list);
    }

    const affectedSecurityKeys = new Set<string>(barsBySecurityKey.keys());
    const existingBarsByDedupKey = new Map<string, HistoricalBar>();
    const existingBarIdsToDelete = new Set<string>();

    await db.transaction('r', db.historicalBars, async () => {
      for (const securityKey of barsBySecurityKey.keys()) {
        const existingBars = await db.historicalBars.where('securityKey').equals(securityKey).toArray();
        for (const existing of existingBars) {
          const dedupKey = makeDedupKey(existing.securityKey, existing.tradeDate);
          if (!existingBarsByDedupKey.has(dedupKey)) {
            existingBarsByDedupKey.set(dedupKey, existing);
          }
        }
      }
    });

    const barsToPut: HistoricalBar[] = [];

    for (const bar of dedupedBars) {
      const securityKey = makeSecurityKey(bar.symbol, bar.market);
      const dedupKey = makeDedupKey(securityKey, bar.tradeDate);
      const existing = existingBarsByDedupKey.get(dedupKey);
      const now = Date.now();

      const newBar: HistoricalBar = {
        id: makeBarId({ market: bar.market, symbol: bar.symbol, assetType: bar.assetType, tradeDate: bar.tradeDate }),
        securityKey,
        symbol: bar.symbol,
        market: bar.market,
        assetType: bar.assetType,
        resolution: RESOLUTION,
        tradeDate: bar.tradeDate,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        adjustedClose: bar.adjustedClose,
        adjustmentMode: bar.adjustmentMode as HistoricalBar['adjustmentMode'] ?? undefined,
        providerId: bar.providerId || bar.sourceId || 'import',
        fetchedAt: bar.fetchedAt ?? now,
        sourceTimestamp: bar.sourceTimestamp,
        dataQuality: bar.dataQuality || 'normal',
        sourceId: bar.sourceId || bar.providerId || 'import',
        sourceName: bar.sourceName,
        sourceType: bar.sourceType,
        adjustedMode: bar.adjustedMode,
      };

      if (existing) {
        if (!overwrite) {
          report.skipped++;
          continue;
        }
        existingBarIdsToDelete.add(existing.id!);
        report.overwritten++;
        report.overwrittenDetails.push({
          securityKey,
          tradeDate: bar.tradeDate,
          oldProviderId: existing.providerId,
          oldSourceName: existing.sourceName,
          oldFetchedAt: existing.fetchedAt,
        });
      } else {
        report.inserted++;
      }

      barsToPut.push(newBar);
    }

    // 写入 bars，覆盖模式时先删除旧条目
    await db.transaction('rw', [db.historicalBars, db.historicalCoverage, db.marketWorkItems], async () => {
      for (const id of existingBarIdsToDelete) {
        await db.historicalBars.delete(id);
      }
      for (const bar of barsToPut) {
        await db.historicalBars.put(bar);
      }
    });

    // 重建 coverage 与 reconcile 队列
    await this.rebuildCoverageFor(affectedSecurityKeys);
    await this.reconcileMarketWorkItems();

    return report;
  }

  /**
   * 导出 missing-market-data-v1.json，来自当前队列中尚未完成的 historical_range_fill / daily_close_update。
   * 按标的合并为单一请求，覆盖该标的所有相关交易记录的时间范围。
   */
  async exportMissingMarketData(): Promise<{ data: MissingMarketDataPackageV1; blob: Blob; fileName: string }> {
    const activeStatuses: MarketWorkItem['status'][] = [
      'pending',
      'running',
      'retry_scheduled',
      'paused_quota',
      'paused_provider_error',
    ];

    const items = await db.marketWorkItems
      .where('kind')
      .anyOf(['historical_range_fill', 'daily_close_update'])
      .and((item) => activeStatuses.includes(item.status))
      .toArray();

    // 按标的合并，过滤非行情标的，确保每个证券/期权只有一条请求
    const groups = new Map<
      string,
      {
        securityKey: string;
        symbol: string;
        market: string;
        assetType: 'stock' | 'option';
        requiredFromDate: string;
        requiredToDate: string;
      }
    >();

    for (const item of items) {
      if (!item.securityKey || !item.symbol || !item.market || !item.assetType) continue;
      if (item.market === 'CASH') continue;
      const assetType = item.assetType.toLowerCase() as 'stock' | 'option';
      if (assetType !== 'stock' && assetType !== 'option') continue;
      const symbolUpper = item.symbol.toUpperCase();
      if (NON_QUOTABLE_SYMBOLS.has(symbolUpper)) continue;

      const fromDate =
        item.kind === 'daily_close_update'
          ? item.tradeDate || item.requiredFromDate || item.requiredToDate || ''
          : item.requiredFromDate || '';
      const toDate =
        item.kind === 'daily_close_update'
          ? item.tradeDate || item.requiredToDate || item.requiredFromDate || ''
          : item.requiredToDate || '';
      if (!fromDate || !toDate) continue;

      const existing = groups.get(item.securityKey);
      if (existing) {
        if (fromDate < existing.requiredFromDate) existing.requiredFromDate = fromDate;
        if (toDate > existing.requiredToDate) existing.requiredToDate = toDate;
      } else {
        groups.set(item.securityKey, {
          securityKey: item.securityKey,
          symbol: item.symbol,
          market: item.market,
          assetType,
          requiredFromDate: fromDate,
          requiredToDate: toDate,
        });
      }
    }

    const exportedItems = Array.from(groups.values()).map((group) => ({
      securityKey: group.securityKey,
      symbol: group.symbol,
      market: group.market,
      assetType: group.assetType,
      requiredFromDate: group.requiredFromDate,
      requiredToDate: group.requiredToDate,
      preferredFetchFromDate: group.requiredFromDate,
      preferredFetchToDate: group.requiredToDate,
    }));

    const data: MissingMarketDataPackageV1 = {
      version: 'missing-market-data-v1',
      generatedAt: new Date().toISOString(),
      items: exportedItems as any,
    };

    const text = JSON.stringify(data, null, 2);
    const fileName = `missing-market-data-v1-${new Date().toISOString().split('T')[0]}.json`;
    return { data, blob: new Blob([text], { type: 'application/json' }), fileName };
  }

  /**
   * 检测所有交易标的的历史缺口并写入队列（但不启动执行器）。
   * 每个证券/期权只生成一条请求，从首笔交易覆盖到市场本地的今天。
   */
  async detectAndQueueMissingRanges(referenceAt = new Date()): Promise<{ queued: number; items: { securityKey: string; fromDate: string; toDate: string }[] }> {
    const transactions = await db.transactions.toArray();
    const requests = getHistoricalRangeRequestsFromTransactions(transactions, referenceAt);

    const newItems: MarketWorkItem[] = [];
    const result: { securityKey: string; fromDate: string; toDate: string }[] = [];

    for (const req of requests) {
      // A successful historical request records the provider-confirmed range in
      // historicalCoverage, including exchange holidays with no daily bar.  Do
      // not infer a gap from weekday bars here: doing so makes every app launch
      // re-request the same complete range (and repeatedly retries holidays).
      const coverage = (await db.historicalCoverage.where('securityKey').equals(req.securityKey).toArray())
        .filter((item) => item.resolution === RESOLUTION && item.coverageStatus === 'complete')
        .sort((left, right) => left.fromDate.localeCompare(right.fromDate));
      const uncovered = subtractCoveredRanges(req.fromDate, req.toDate, coverage.map((item) => ({ fromDate: item.fromDate, toDate: item.toDate })));

      for (const missing of uncovered) {
        const id = `hist_fill_${req.market}_${req.symbol}_${missing.fromDate}_${missing.toDate}`;
        newItems.push({
          id,
          kind: 'historical_range_fill',
          securityKey: req.securityKey,
          symbol: req.symbol,
          market: req.market,
          assetType: req.assetType,
          resolution: RESOLUTION,
          requiredFromDate: missing.fromDate,
          requiredToDate: missing.toDate,
          fetchFromDate: missing.fromDate,
          fetchToDate: missing.toDate,
          sourceReason: 'manual',
          priority: 850,
          status: 'pending',
          attemptCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        result.push({ securityKey: req.securityKey, fromDate: missing.fromDate, toDate: missing.toDate });
      }
    }

    if (newItems.length > 0) {
      await upsertMarketWorkItems(newItems);
    }

    return { queued: newItems.length, items: result };
  }

  /**
   * 为指定 securityKey 集合重建 historicalCoverage。
   */
  async rebuildCoverageFor(securityKeys: Set<string>): Promise<void> {
    const now = Date.now();
    const keysArray = Array.from(securityKeys);

    await db.transaction('rw', [db.historicalBars, db.historicalCoverage], async () => {
      for (const securityKey of keysArray) {
        const bars = await db.historicalBars
          .where('securityKey')
          .equals(securityKey)
          .and((b) => b.resolution === RESOLUTION)
          .toArray();

        if (bars.length === 0) continue;

        bars.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
        const fromDate = bars[0].tradeDate;
        const toDate = bars[bars.length - 1].tradeDate;

        const gaps = await HistoricalGapAnalyzer.findMissingHistoricalRanges({
          securityKey,
          resolution: RESOLUTION,
          requiredFromDate: fromDate,
          requiredToDate: toDate,
        });

        const latestBar = bars[bars.length - 1];
        const coverageStatus: HistoricalCoverage['coverageStatus'] =
          gaps.length === 0 ? 'complete' : 'partial';

        const existingCoverage = await db.historicalCoverage
          .where('securityKey')
          .equals(securityKey)
          .toArray();

        for (const cov of existingCoverage) {
          await db.historicalCoverage.delete(cov.id!);
        }

        await db.historicalCoverage.add({
          securityKey,
          resolution: RESOLUTION,
          fromDate,
          toDate,
          providerId: latestBar.providerId,
          coverageStatus,
          updatedAt: now,
          sourceId: latestBar.sourceId,
          sourceName: latestBar.sourceName,
          sourceType: latestBar.sourceType,
          adjustedMode: latestBar.adjustedMode,
        });
      }
    });
  }

  /**
   * 根据当前缓存重新 reconcile marketWorkItems：
   * - 缺口已被覆盖 -> success
   * - 部分覆盖 -> 保持 pending（不再拆分，每个证券/期权只保留一条请求）
   * - daily_close_update -> 有 bar 则 success
   */
  async reconcileMarketWorkItems(): Promise<void> {
    const activeStatuses: MarketWorkItem['status'][] = [
      'pending',
      'running',
      'retry_scheduled',
      'paused_quota',
      'paused_provider_error',
    ];

    const activeItems = await db.marketWorkItems
      .where('kind')
      .anyOf(['historical_range_fill', 'daily_close_update'])
      .and((item) => activeStatuses.includes(item.status))
      .toArray();

    const now = Date.now();
    const updates: { id: string; changes: Partial<MarketWorkItem> }[] = [];

    for (const item of activeItems) {
      if (!item.securityKey) continue;

      if (item.kind === 'daily_close_update') {
        const tradeDate = item.tradeDate;
        if (!tradeDate) continue;
        const hasBar = await db.historicalBars
          .where('securityKey')
          .equals(item.securityKey)
          .and((b) => b.resolution === RESOLUTION && b.tradeDate === tradeDate)
          .first();
        if (hasBar) {
          updates.push({ id: item.id, changes: { status: 'success', updatedAt: now } });
        }
        continue;
      }

      // historical_range_fill: 只检查是否完全覆盖，不拆分
      const requiredFrom = item.requiredFromDate;
      const requiredTo = item.requiredToDate;
      if (!requiredFrom || !requiredTo) continue;

      const gaps = await HistoricalGapAnalyzer.findMissingHistoricalRanges({
        securityKey: item.securityKey,
        resolution: RESOLUTION,
        requiredFromDate: requiredFrom,
        requiredToDate: requiredTo,
      });

      if (gaps.length === 0) {
        updates.push({ id: item.id, changes: { status: 'success', updatedAt: now } });
      }
      // 如果仍有缺口，保持原有 pending 状态，不拆分、不修改区间
    }

    if (updates.length > 0) {
      await db.transaction('rw', db.marketWorkItems, async () => {
        for (const { id, changes } of updates) {
          await db.marketWorkItems.update(id, changes);
        }
      });
    }
  }

  /**
   * 为单个证券/期权生成一条历史区间补齐任务（基于该证券的全部交易记录）。
   * 用于个股详情页等显式“获取该证券行情”的场景。
   */
  async queueHistoricalRangeForSecurity(
    symbol: string,
    market: string,
    _assetType: 'stock' | 'option' = 'stock',
    range?: { fromDate: string; toDate: string }
  ): Promise<void> {
    if (!symbol || !market) return;
    const securityKey = `${market}:${symbol}`;

    const transactions = await db.transactions.toArray();
    const requests = getHistoricalRangeRequestsFromTransactions(transactions);
    const request = requests.find((r) => r.securityKey === securityKey);
    if (!request) return;

    const fromDate = range?.fromDate ?? request.fromDate;
    const toDate = range?.toDate ?? request.toDate;
    const id = `hist_fill_${request.market}_${request.symbol}_${fromDate}_${toDate}`;
    const item: MarketWorkItem = {
      id,
      kind: 'historical_range_fill',
      securityKey: request.securityKey,
      symbol: request.symbol,
      market: request.market,
      assetType: request.assetType,
      resolution: RESOLUTION,
      requiredFromDate: fromDate,
      requiredToDate: toDate,
      fetchFromDate: fromDate,
      fetchToDate: toDate,
      sourceReason: 'manual',
      priority: 850,
      status: 'pending',
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await upsertMarketWorkItems([item]);
  }

  /**
   * 启动行情任务执行器（显式用户操作）。
   */
  async startExecutor(): Promise<void> {
    await MarketTaskExecutor.startOrWakeMarketExecutor();
  }

  private toImportBar(bar: HistoricalBar): HistoricalBarImport {
    return {
      symbol: bar.symbol,
      market: bar.market as any,
      assetType: bar.assetType as any,
      resolution: bar.resolution as any,
      tradeDate: bar.tradeDate,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      adjustedClose: bar.adjustedClose,
      adjustmentMode: bar.adjustmentMode,
      providerId: bar.providerId,
      fetchedAt: bar.fetchedAt,
      sourceTimestamp: bar.sourceTimestamp,
      dataQuality: bar.dataQuality,
      sourceId: bar.sourceId,
      sourceName: bar.sourceName,
      sourceType: bar.sourceType,
      adjustedMode: bar.adjustedMode,
    };
  }

  private toImportCoverage(coverage: HistoricalCoverage): {
    securityKey: string;
    resolution: '1d';
    fromDate: string;
    toDate: string;
    providerId?: string;
    coverageStatus?: 'complete' | 'partial' | 'unknown';
    updatedAt?: number;
    sourceId?: string;
    sourceName?: string;
    sourceType?: string;
    adjustedMode?: string;
  } {
    return {
      securityKey: coverage.securityKey,
      resolution: coverage.resolution as any,
      fromDate: coverage.fromDate,
      toDate: coverage.toDate,
      providerId: coverage.providerId,
      coverageStatus: coverage.coverageStatus,
      updatedAt: coverage.updatedAt,
      sourceId: coverage.sourceId,
      sourceName: coverage.sourceName,
      sourceType: coverage.sourceType,
      adjustedMode: coverage.adjustedMode,
    };
  }
}

export const marketCacheManager = new MarketCacheManager();
