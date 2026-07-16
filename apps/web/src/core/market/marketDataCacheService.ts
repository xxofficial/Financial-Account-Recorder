import { db } from '../../db/localDb';
import { QuoteSnapshot, HistoricalDailyBar, HistoricalBar } from '../../db/schema';
import { StockSdkProvider } from './stockSdkProvider';
import { MarketDataAppProvider } from './marketDataProvider';
import { MarketDataProvider, type MarketProviderSecurityInfo } from './marketDataProvider';
import { upsertMarketWorkItems } from './marketQueueManager';
import { MarketTaskExecutor } from './MarketTaskExecutor';
import { AndroidDefaultMarketProvider } from './androidDefaultMarketProvider';
import { PortfolioCalculator } from '../portfolio/portfolioCalculator';
import { tradingCalendarService } from './tradingCalendarService';

const MARKET_TIME_ZONES: Record<string, string> = { US: 'America/New_York', HK: 'Asia/Hong_Kong', A_SHARE: 'Asia/Shanghai' };

export interface SecuritySuggestion {
  symbol: string;
  market: string;
  name: string;
  assetType: 'STOCK';
}

export interface SecurityNameRepairResult {
  resolvedSecurities: number;
  updatedTransactions: number;
  unresolvedSecurities: number;
}

function suggestionKey(item: Pick<SecuritySuggestion, 'market' | 'symbol'>): string {
  return `${item.market.toUpperCase()}:${item.symbol.trim().toUpperCase()}`;
}

/** Exact code, code prefix, then name match; stable alphabetic tie-breaking. */
export function rankSecuritySuggestions(query: string, items: SecuritySuggestion[], limit = 6): SecuritySuggestion[] {
  const needle = query.trim().toLowerCase();
  const unique = new Map<string, SecuritySuggestion>();
  for (const item of items) {
    if (!item.symbol.trim() || !item.name.trim()) continue;
    const key = suggestionKey(item);
    if (!unique.has(key)) unique.set(key, { ...item, symbol: item.symbol.trim().toUpperCase() });
  }
  const rank = (item: SecuritySuggestion) => {
    const symbol = item.symbol.toLowerCase();
    const name = item.name.toLowerCase();
    if (symbol === needle) return 0;
    if (symbol.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    return 3;
  };
  return [...unique.values()]
    .filter((item) => !needle || item.symbol.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle))
    .sort((left, right) => rank(left) - rank(right) || left.symbol.localeCompare(right.symbol) || left.name.localeCompare(right.name, 'zh-Hans-CN'))
    .slice(0, limit);
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Synchronous weekday fallback retained for callers that cannot await calendar I/O. */
export function latestExpectedDailyCloseDate(market: string, referenceAt = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONES[market] ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(referenceAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  let date = addUtcDays(`${part('year')}-${part('month')}-${part('day')}`, -1);
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addUtcDays(date, -1);
  return date;
}

/** Uses the stock-sdk official A-share calendar; HK/US retain weekday fallback. */
export async function resolveLatestExpectedDailyCloseDate(market: string, referenceAt = new Date()): Promise<string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIME_ZONES[market] ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(referenceAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return tradingCalendarService.previousExpectedCloseDate(market, `${part('year')}-${part('month')}-${part('day')}`);
}

export class MarketDataCacheService {
  private providers: Record<string, MarketDataProvider> = {
    'android-default': new AndroidDefaultMarketProvider(),
    'stock-sdk': new StockSdkProvider(),
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
      .filter(item => item.provider !== undefined && (item.apiKey.trim() !== '' || item.provider.name === 'stock-sdk' || item.provider.name === 'android-default'));
    return configuredProviders;
  }

  /**
   * Finds stock candidates without mutating quote/history caches.  Local data is
   * always retained when a provider is unavailable or its request fails.
   */
  async suggestSecurities(query: string, market: string, limit = 6): Promise<SecuritySuggestion[]> {
    const cleanQuery = query.trim();
    const cleanMarket = market.toUpperCase();
    if (!cleanQuery || !cleanMarket || cleanMarket === 'CASH') return [];

    const [quotes, transactions] = await Promise.all([db.quoteSnapshots.toArray(), db.transactions.toArray()]);
    const local = rankSecuritySuggestions(cleanQuery, [
      ...quotes.filter((quote) => quote.market === cleanMarket && quote.assetType === 'STOCK').map((quote) => ({ symbol: quote.symbol, market: quote.market, name: quote.name || quote.symbol, assetType: 'STOCK' as const })),
      ...transactions.filter((transaction) => transaction.market === cleanMarket && transaction.assetType === 'STOCK' && transaction.symbol).map((transaction) => ({ symbol: transaction.symbol, market: transaction.market, name: transaction.name || transaction.symbol, assetType: 'STOCK' as const })),
    ], limit);

    const remote: SecuritySuggestion[] = [];
    for (const { provider, apiKey } of await this.getActiveProviders()) {
      if (!provider.supportsAssetType('STOCK') || !provider.supportsMarket(cleanMarket)) continue;
      try {
        if (provider.suggestSecurities) {
          const result = await provider.suggestSecurities(cleanQuery, cleanMarket, apiKey, limit);
          if (result.ok && result.data) remote.push(...result.data.filter((item) => item.assetType === 'STOCK').map((item) => ({ ...item, market: cleanMarket, assetType: 'STOCK' as const })));
        } else {
          const result = await provider.searchSecurity(cleanQuery, cleanMarket, apiKey);
          if (result.ok && result.data?.name) remote.push(this.toSuggestion(result.data, cleanMarket));
        }
      } catch (error) {
        console.warn(`Provider ${provider.name} failed during security suggestion`, error);
      }
    }
    return rankSecuritySuggestions(cleanQuery, [...local, ...remote], limit);
  }

  private toSuggestion(info: MarketProviderSecurityInfo, market: string): SecuritySuggestion {
    return { symbol: info.symbol, market, name: info.name || info.symbol, assetType: 'STOCK' };
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

  /** Retrieves the canonical name from the configured market-source priority. */
  private async resolveOfficialSecurityName(symbol: string, market: string): Promise<string | null> {
    const cleanSymbol = symbol.trim().toUpperCase();
    const cleanMarket = market.trim().toUpperCase();
    if (!cleanSymbol || !cleanMarket || cleanMarket === 'CASH' || cleanSymbol === 'CASH' || cleanSymbol === 'INTEREST') return null;

    const activeList = await this.getActiveProviders();
    for (const { provider, apiKey } of activeList) {
      if (!provider.supportsAssetType('STOCK') || !provider.supportsMarket(cleanMarket)) {
        continue;
      }

      try {
        console.log(`Resolving name for ${cleanSymbol} via ${provider.name}...`);
        const result = await provider.searchSecurity(cleanSymbol, cleanMarket, apiKey);
        const name = result.data?.name?.trim();
        if (result.ok && result.data && name && name.toUpperCase() !== cleanSymbol) {
          const info = result.data;
          const existing = await db.quoteSnapshots.get(`${cleanMarket}:${cleanSymbol}`);
          if (existing) await db.quoteSnapshots.update(existing.id, { name });
          else await db.quoteSnapshots.put({
            id: `${cleanMarket}:${cleanSymbol}`,
            symbol: cleanSymbol,
            market: cleanMarket,
            name,
            assetType: info.assetType,
            currentPrice: null,
            previousClose: null,
            change: null,
            changePercent: null,
            currency: cleanMarket === 'US' ? 'USD' : cleanMarket === 'HK' ? 'HKD' : 'CNY',
            provider: provider.name,
            fetchedAt: Date.now(),
            requestStatus: 'success',
          });
          return name;
        }
      } catch (e) {
        console.error(`Provider ${provider.name} failed during searchSecurity:`, e);
      }
    }

    return null;
  }

  /**
   * Returns a market-source name when available, with local data only as an
   * offline fallback. New entries therefore share the same source-led name as
   * existing records for that market and code.
   */
  async resolveSecurityName(symbol: string, market: string): Promise<string | null> {
    const cleanSymbol = symbol.trim().toUpperCase();
    const cleanMarket = market.trim().toUpperCase();
    const officialName = await this.resolveOfficialSecurityName(cleanSymbol, cleanMarket);
    if (officialName) return officialName;
    const cachedQuote = await db.quoteSnapshots.get(`${cleanMarket}:${cleanSymbol}`);
    if (cachedQuote?.name?.trim() && cachedQuote.name.trim().toUpperCase() !== cleanSymbol) return cachedQuote.name;
    const transaction = await db.transactions.where('[market+symbol]').equals([cleanMarket, cleanSymbol]).first();
    return transaction?.name?.trim() && transaction.name.trim().toUpperCase() !== cleanSymbol ? transaction.name : null;
  }

  /**
   * Android parity: retrieve each security's name from the market source, then
   * write it back to every matching non-option transaction across platforms.
   */
  async repairSecurityNames(targets?: Array<{ symbol: string; market: string }>): Promise<SecurityNameRepairResult> {
    const allTargets = targets ?? (await db.transactions.toArray()).map((transaction) => ({ symbol: transaction.symbol, market: transaction.market }));
    const uniqueTargets = new Map<string, { symbol: string; market: string }>();
    for (const target of allTargets) {
      const symbol = target.symbol.trim().toUpperCase();
      const market = target.market.trim().toUpperCase();
      if (!symbol || !market || market === 'CASH' || symbol === 'CASH' || symbol === 'INTEREST') continue;
      uniqueTargets.set(`${market}:${symbol}`, { symbol, market });
    }

    let resolvedSecurities = 0;
    let updatedTransactions = 0;
    let unresolvedSecurities = 0;
    for (const { symbol, market } of uniqueTargets.values()) {
      const name = await this.resolveOfficialSecurityName(symbol, market);
      if (!name) {
        unresolvedSecurities += 1;
        continue;
      }
      resolvedSecurities += 1;
      const matchingTransactions = await db.transactions.where('[market+symbol]').equals([market, symbol]).toArray();
      const now = Date.now();
      await db.transaction('rw', db.transactions, async () => {
        for (const transaction of matchingTransactions) {
          if (transaction.assetType === 'OPTION' || transaction.name === name) continue;
          await db.transactions.update(transaction.id!, { name, updatedAt: now });
          updatedTransactions += 1;
        }
      });
    }
    return { resolvedSecurities, updatedTransactions, unresolvedSecurities };
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
        const latestDate = await resolveLatestExpectedDailyCloseDate(sec.market, referenceAt);
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
