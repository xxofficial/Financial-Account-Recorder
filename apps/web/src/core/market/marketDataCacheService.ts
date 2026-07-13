import { db } from '../../db/localDb';
import { QuoteSnapshot, HistoricalDailyBar, HistoricalBar } from '../../db/schema';
import { ItickProvider } from './itickProvider';
import { TwelvedataProvider } from './twelvedataProvider';
import { MarketDataAppProvider } from './marketDataProvider';
import { MarketDataProvider } from './marketDataProvider';
import { upsertMarketWorkItems } from './marketQueueManager';
import { MarketTaskExecutor } from './MarketTaskExecutor';
import { AndroidDefaultMarketProvider } from './androidDefaultMarketProvider';
import { isAndroidNativeRuntime } from '../../platform/nativeRuntime';
import { PortfolioCalculator } from '../portfolio/portfolioCalculator';

const MARKET_TIME_ZONES: Record<string, string> = { US: 'America/New_York', HK: 'Asia/Hong_Kong', A_SHARE: 'Asia/Shanghai' };

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Latest weekday that should have a daily close for this market. Exchange-holiday support remains a TODO. */
export function latestExpectedDailyCloseDate(market: string, referenceAt = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONES[market] ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(referenceAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  let date = addUtcDays(`${part('year')}-${part('month')}-${part('day')}`, -1);
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addUtcDays(date, -1);
  return date;
}

export class MarketDataCacheService {
  private providers: Record<string, MarketDataProvider> = {
    'android-default': new AndroidDefaultMarketProvider(),
    itick: new ItickProvider(),
    twelvedata: new TwelvedataProvider(),
    marketdata: new MarketDataAppProvider(),
  };

  /**
   * Get all active and configured providers in priority order (1 is highest priority)
   */
  private async getActiveProviders(): Promise<{ provider: MarketDataProvider; apiKey: string }[]> {
    const configs = await db.marketProviderConfigs.where('enabled').equals(1).toArray();
    configs.sort((a, b) => a.priority - b.priority);

    const configuredProviders = configs
      .map(c => ({
        provider: this.providers[c.provider],
        apiKey: c.apiKey
      }))
      .filter(item => item.provider !== undefined && item.apiKey.trim() !== '');
    return isAndroidNativeRuntime()
      ? [{ provider: this.providers['android-default'], apiKey: '' }, ...configuredProviders]
      : configuredProviders;
  }

  /**
   * Refresh quotes for a list of securities by calling active providers.
   * If isManual is false, it returns local cached values immediately without hitting APIs.
   * If isManual is true, it queues realtime task items, wakes executor, polls for completion, and returns.
   */
  async refreshQuotes(
    securities: { symbol: string; market: string; assetType: 'STOCK' | 'OPTION' }[],
    isManual = false
  ): Promise<QuoteSnapshot[]> {
    if (securities.length === 0) return [];

    const now = Date.now();

    if (!isManual) {
      // 1. Automatic/background trigger: return cached snapshots immediately
      const results: QuoteSnapshot[] = [];
      for (const sec of securities) {
        const key = `${sec.market}:${sec.symbol}`;
        const cached = await db.quoteSnapshots.get(key);
        if (cached) {
          results.push(cached);
        } else {
          // Put dummy holding quote
          results.push({
            id: key,
            symbol: sec.symbol,
            market: sec.market,
            name: sec.symbol,
            assetType: sec.assetType,
            currentPrice: null,
            previousClose: null,
            change: null,
            changePercent: null,
            currency: sec.market === 'US' ? 'USD' : sec.market === 'HK' ? 'HKD' : 'CNY',
            provider: 'none',
            fetchedAt: now,
            requestStatus: 'provider_unconfigured'
          });
        }
      }
      return results;
    }

    // 2. Manual trigger: queue tasks, wake executor, wait, and return
    const workItems = securities.map(sec => ({
      id: `quote_refresh_${sec.market}_${sec.symbol}`,
      kind: 'realtime_quote_refresh' as const,
      securityKey: `${sec.market}:${sec.symbol}`,
      symbol: sec.symbol,
      market: sec.market,
      assetType: sec.assetType.toLowerCase() as any,
      sourceReason: 'manual' as const,
      priority: 900,
      status: 'pending' as const,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    }));

    // Update global refresh status
    const activeList = await this.getActiveProviders();
    const statusObj = {
      isRefreshing: true,
      currentProvider: activeList.length > 0 ? activeList[0].provider.name : 'none',
      refreshedCount: 0,
      failedCount: 0,
      cacheHitCount: 0,
      triggeredFallback: false,
      fallbackMessage: '',
      lastUpdated: now
    };
    await db.appSettings.put({ key: 'market_refresh_status', value: statusObj, updatedAt: now });

    await upsertMarketWorkItems(workItems);
    await MarketTaskExecutor.startOrWakeMarketExecutor();

    // Poll for completion (up to 10 seconds)
    const ids = workItems.map(w => w.id);
    const startTime = Date.now();
    while (Date.now() - startTime < 10000) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const currentItems = await db.marketWorkItems.where('id').anyOf(ids).toArray();
      const allDone = currentItems.every(item => ['success', 'failed_permanent', 'no_data', 'unsupported'].includes(item.status));
      if (allDone) break;
    }

    // Read final refreshed values from database
    const results: QuoteSnapshot[] = [];
    let refreshedCount = 0;
    let failedCount = 0;

    for (const sec of securities) {
      const key = `${sec.market}:${sec.symbol}`;
      const cached = await db.quoteSnapshots.get(key);
      if (cached) {
        results.push(cached);
        if (cached.requestStatus === 'success') {
          refreshedCount++;
        } else {
          failedCount++;
        }
      }
    }

    // Update global refresh status to finished
    await db.appSettings.put({
      key: 'market_refresh_status',
      value: {
        isRefreshing: false,
        currentProvider: 'none',
        refreshedCount,
        failedCount,
        cacheHitCount: 0,
        triggeredFallback: false,
        fallbackMessage: '',
        lastUpdated: Date.now()
      },
      updatedAt: Date.now()
    });

    return results;
  }

  /**
   * Fetch historical daily bars from local cache only.
   * This method no longer auto-fetches missing data; use MarketCachePage for explicit sync.
   */
  async getHistoricalBars(
    symbol: string,
    market: string,
    _assetType: 'STOCK' | 'OPTION',
    startDate: string, // YYYY-MM-DD
    endDate: string    // YYYY-MM-DD
  ): Promise<HistoricalDailyBar[]> {
    // 1. Query existing bars from local database
    const localBars = await db.historicalBars
      .where('securityKey')
      .equals(`${market}:${symbol}`)
      .toArray();

    const filteredBars = localBars
      .filter(b => b.resolution === '1d' && b.tradeDate >= startDate && b.tradeDate <= endDate)
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));

    // Convert HistoricalBar to HistoricalDailyBar format for compatibility
    return filteredBars.map((b: HistoricalBar): HistoricalDailyBar => ({
      id: b.id || `${b.market}:${b.symbol}:${b.assetType}:${b.tradeDate}`,
      symbol: b.symbol,
      market: b.market,
      assetType: b.assetType.toUpperCase() as 'STOCK' | 'OPTION',
      date: b.tradeDate,
      open: b.open ?? null,
      high: b.high ?? null,
      low: b.low ?? null,
      close: b.close,
      volume: b.volume ?? null,
      provider: b.providerId,
      fetchedAt: b.fetchedAt
    }));
  }

  /**
   * Resolve security name by checking local database first, then fallback to APIs
   */
  async resolveSecurityName(symbol: string, market: string): Promise<string | null> {
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) return null;

    // 1. Check local quoteSnapshots
    const cachedQuote = await db.quoteSnapshots.get(`${market}:${cleanSymbol}`);
    if (cachedQuote && cachedQuote.name && cachedQuote.name !== cleanSymbol) {
      return cachedQuote.name;
    }

    // 2. Check existing transactions for this symbol
    const tx = await db.transactions
      .where('[market+symbol]')
      .equals([market, cleanSymbol])
      .first();
    if (tx && tx.name && tx.name !== cleanSymbol) {
      return tx.name;
    }

    // 3. Fallback to querying active providers
    const activeList = await this.getActiveProviders();
    for (const { provider, apiKey } of activeList) {
      if (!provider.supportsAssetType('STOCK') || !provider.supportsMarket(market)) {
        continue;
      }

      try {
        console.log(`Resolving name for ${cleanSymbol} via ${provider.name}...`);
        const result = await provider.searchSecurity(cleanSymbol, market, apiKey);
        if (result.ok && result.data && result.data.name) {
          const info = result.data;
          
          await db.quoteSnapshots.put({
            id: `${market}:${cleanSymbol}`,
            symbol: cleanSymbol,
            market,
            name: info.name,
            assetType: info.assetType,
            currentPrice: null,
            previousClose: null,
            change: null,
            changePercent: null,
            currency: market === 'US' ? 'USD' : market === 'HK' ? 'HKD' : 'CNY',
            provider: provider.name,
            fetchedAt: Date.now(),
            requestStatus: 'success'
          } as any);

          return info.name;
        }
      } catch (e) {
        console.error(`Provider ${provider.name} failed during searchSecurity:`, e);
      }
    }

    return null;
  }

  /**
   * Schedule EOD daily close update tasks for all unique securities on application start/mount
   */
  async triggerDailyCloseUpdate(referenceAt = new Date()): Promise<void> {
    try {
      const transactions = await db.transactions.toArray();
      if (transactions.length === 0) return;

      const positions = new PortfolioCalculator().calculate(transactions, [], { usdToCny: 1, hkdToCny: 1 }).positions;
      const securitiesMap = new Map<string, { symbol: string; market: string; assetType: string }>();
      for (const tx of transactions) {
        const key = `${tx.market}:${tx.symbol}`;
        if (tx.symbol && tx.market !== 'CASH' && Math.abs(positions[key]?.quantity ?? 0) > 1e-5) {
          securitiesMap.set(key, {
            symbol: tx.symbol,
            market: tx.market,
            assetType: tx.assetType || 'STOCK'
          });
        }
      }

      const newItems = [];
      for (const [key, sec] of securitiesMap.entries()) {
        const latestDate = latestExpectedDailyCloseDate(sec.market, referenceAt);
        const itemId = `daily_update_${sec.market}_${sec.symbol}_${latestDate}`;
        const previous = await db.marketWorkItems.get(itemId);
        // A provider-confirmed no_data result represents a holiday/closure
        // until a proper exchange calendar is available. Do not retry it on
        // every subsequent app open.
        if (previous && ['success', 'no_data'].includes(previous.status)) continue;
        const hasBar = await db.historicalBars
          .where('[securityKey+resolution+tradeDate]')
          .equals([key, '1d', latestDate])
          .first();

        if (!hasBar) {
          newItems.push({
            id: itemId,
            kind: 'daily_close_update' as const,
            securityKey: key,
            symbol: sec.symbol,
            market: sec.market,
            assetType: sec.assetType.toLowerCase() as any,
            resolution: '1d' as const,
            tradeDate: latestDate,
            sourceReason: 'daily_close_update' as const,
            priority: 700,
            status: 'pending' as const,
            attemptCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
        }
      }

      if (newItems.length > 0) {
        await upsertMarketWorkItems(newItems);
        // AppShell wakes the executor after its startup check. Keeping this
        // method queue-only also lets event-specific callers reuse it.
      }
    } catch (err) {
      console.error('Failed to trigger EOD daily close updates:', err);
    }
  }
}

export const cacheService = new MarketDataCacheService();
