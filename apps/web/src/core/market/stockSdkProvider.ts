import { StockSDK, normalizeSymbol, toTencentSymbol } from 'stock-sdk';
import { marketFetch } from '../../platform/nativeRuntime';
import type { HistoricalDailyBar, QuoteSnapshot } from '../../db/schema';
import type { MarketDataProvider, MarketProviderSecurityInfo, MarketProviderSecuritySuggestion } from './marketDataProvider';
import { logMarketRequest, type MarketDataResult } from './marketRequestHelper';

type StockRequest = { symbol: string; market: string; assetType: 'STOCK' | 'OPTION' };

const STOCK_MARKETS = new Set(['A_SHARE', 'HK', 'US']);

/**
 * Keyless stock provider backed by stock-sdk.  Keep this deliberately narrow:
 * domestic options exposed by stock-sdk are not US individual options and are
 * therefore not part of the ledger option route.
 */
export class StockSdkProvider implements MarketDataProvider {
  readonly name = 'stock-sdk';

  supportsAssetType(assetType: string): boolean {
    return assetType.toUpperCase() === 'STOCK';
  }

  supportsMarket(market: string): boolean {
    return STOCK_MARKETS.has((market || '').toUpperCase());
  }

  async testConnection(_apiKey: string): Promise<MarketDataResult<boolean>> {
    const result = await this.fetchQuotes([{ symbol: 'AAPL', market: 'US', assetType: 'STOCK' }], '');
    return { ...result, data: result.ok && Boolean(result.data?.length) };
  }

  async fetchQuotes(symbols: StockRequest[], _apiKey: string): Promise<MarketDataResult<QuoteSnapshot[]>> {
    const supported = symbols.filter(item => this.supportsAssetType(item.assetType) && this.supportsMarket(item.market));
    if (!supported.length) return this.skipped<QuoteSnapshot[]>();

    const startedAt = Date.now();
    await this.started('quote', supported.map(item => item.symbol).join(','), supported[0].market);
    try {
      const sdk = this.sdk();
      const quotes: QuoteSnapshot[] = [];
      for (const market of ['A_SHARE', 'HK', 'US'] as const) {
        const group = supported.filter(item => item.market.toUpperCase() === market);
        if (!group.length) continue;
        const sourceCodes = group.map(item => this.toSdkSymbol(item.symbol, market));
        const rows: any[] = market === 'A_SHARE'
          ? await sdk.quotes.cnSimple(sourceCodes)
          : market === 'HK'
            ? await sdk.quotes.hk(sourceCodes)
            : await sdk.quotes.us(sourceCodes);

        for (const item of group) {
          const row = rows.find(candidate => this.sameSymbol(candidate?.code, item.symbol, market));
          if (!row || !this.isPositive(row.price)) continue;
          const previousClose = this.finiteOrNull(row.prevClose);
          const currentPrice = Number(row.price);
          quotes.push({
            id: `${item.market}:${item.symbol}`,
            symbol: item.symbol,
            market: item.market,
            name: row.name || item.symbol,
            assetType: 'STOCK',
            currentPrice,
            previousClose,
            change: previousClose === null ? null : currentPrice - previousClose,
            changePercent: previousClose && previousClose !== 0 ? ((currentPrice - previousClose) / previousClose) * 100 : null,
            currency: market === 'A_SHARE' ? 'CNY' : market === 'HK' ? 'HKD' : 'USD',
            provider: this.name,
            fetchedAt: Date.now()
          });
        }
      }
      if (!quotes.length) return this.failed('empty_data', '未返回目标标的的有效快照', startedAt);
      await this.succeeded('quote', quotes.length, startedAt);
      return { ok: true, status: 'success', provider: this.name, data: quotes, durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.fromError(error, startedAt);
    }
  }

  async fetchHistoricalBars(symbol: string, market: string, assetType: 'STOCK' | 'OPTION', startDate: string, endDate: string, _apiKey: string): Promise<MarketDataResult<HistoricalDailyBar[]>> {
    if (!this.supportsAssetType(assetType) || !this.supportsMarket(market)) return this.skipped<HistoricalDailyBar[]>();
    const normalizedMarket = market.toUpperCase() as 'A_SHARE' | 'HK' | 'US';
    const startedAt = Date.now();
    await this.started('history', symbol, market);
    try {
      // stock-sdk only reads startDate/endDate.  Passing start/end silently
      // falls back to its 1970–2050 default range, which is large enough for
      // the upstream socket to drop the request.
      const options = { period: 'daily', startDate: startDate.replaceAll('-', ''), endDate: endDate.replaceAll('-', ''), adjust: '' } as any;
      const sdk = this.sdk();
      const sourceSymbol = this.toSdkSymbol(symbol, normalizedMarket);
      const rows: any[] = await this.withTimeout(
        normalizedMarket === 'A_SHARE'
          ? sdk.kline.cn(sourceSymbol, options)
          : normalizedMarket === 'HK'
            ? sdk.kline.hk(sourceSymbol, options)
            : sdk.kline.us(sourceSymbol, options),
        8_000,
      );
      const bars = rows
        .map(row => this.toBar(row, symbol, market, startDate, endDate))
        .filter((bar): bar is HistoricalDailyBar => bar !== null);
      if (!bars.length) return this.failed('empty_data', '未返回请求日期范围内的有效日 K', startedAt);
      if (startDate === endDate && !bars.some(bar => bar.date === startDate)) {
        return this.failed('missing_target_date', `未返回目标日期 ${startDate} 的日 K`, startedAt);
      }
      await this.succeeded('history', bars.length, startedAt, { adjustmentMode: 'raw', startDate, endDate });
      return { ok: true, status: 'success', provider: this.name, data: bars, durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.fromError(error, startedAt);
    }
  }

  async searchSecurity(symbol: string, market: string, _apiKey: string): Promise<MarketDataResult<MarketProviderSecurityInfo | null>> {
    if (!this.supportsMarket(market)) return this.skipped<MarketProviderSecurityInfo | null>();
    const startedAt = Date.now();
    try {
      const result: any[] = await this.sdk().search(symbol);
      const matched = result.find(item => this.sameSymbol(item?.code, symbol, market.toUpperCase() as any));
      if (matched?.name) {
        return { ok: true, status: 'success', provider: this.name, data: { symbol, market, name: matched.name, assetType: 'STOCK' as const }, durationMs: Date.now() - startedAt };
      }

      // stock-sdk's text search is incomplete for some US tickers (for
      // example NVO), while its exact quote endpoint still supplies the
      // canonical security name. Use the same market source as a fallback.
      const quoteResult = await this.fetchQuotes([{ symbol, market, assetType: 'STOCK' }], _apiKey);
      const quote = quoteResult.data?.[0];
      const data = quote?.name ? { symbol, market, name: quote.name, assetType: 'STOCK' as const } : null;
      return { ok: true, status: 'success', provider: this.name, data, durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.fromError(error, startedAt);
    }
  }

  async suggestSecurities(query: string, market: string, _apiKey: string, limit: number): Promise<MarketDataResult<MarketProviderSecuritySuggestion[]>> {
    if (!this.supportsMarket(market)) return this.skipped<MarketProviderSecuritySuggestion[]>();
    const startedAt = Date.now();
    try {
      const requestedMarket = market.toUpperCase() as 'A_SHARE' | 'HK' | 'US';
      const rows: any[] = await this.sdk().search(query.trim());
      const seen = new Set<string>();
      const data = rows.flatMap((row) => {
        const symbol = this.searchResultSymbol(row, requestedMarket);
        if (!symbol || !this.matchesSearchMarket(row, symbol, requestedMarket)) return [];
        const key = `${requestedMarket}:${symbol.toUpperCase()}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ symbol, market: requestedMarket, name: String(row?.name || row?.displayName || symbol), assetType: 'STOCK' as const }];
      }).slice(0, limit);
      return { ok: true, status: 'success', provider: this.name, data, durationMs: Date.now() - startedAt };
    } catch (error) {
      return this.fromError(error, startedAt);
    }
  }

  private sdk(): StockSDK {
    return new StockSDK({ fetchImpl: (input: any, init?: any) => marketFetch(input, init) as any });
  }

  private toSdkSymbol(symbol: string, market: 'A_SHARE' | 'HK' | 'US'): string {
    const raw = symbol.trim();
    if (market === 'A_SHARE') return toTencentSymbol(normalizeSymbol(raw, { market: 'CN' }));
    if (market === 'HK') return raw.replace(/\.HK$/i, '').replace(/^0+/, '').padStart(5, '0');
    return raw.replace(/\.US$/i, '').toUpperCase();
  }

  private sameSymbol(value: unknown, symbol: string, market: 'A_SHARE' | 'HK' | 'US'): boolean {
    const actual = this.comparableSymbol(String(value || ''), market);
    const expected = this.comparableSymbol(this.toSdkSymbol(symbol, market), market);
    return market === 'HK' ? actual.replace(/^0+/, '') === expected.replace(/^0+/, '') : actual === expected;
  }

  private searchResultSymbol(row: any, market: 'A_SHARE' | 'HK' | 'US'): string {
    const raw = String(row?.code || row?.symbol || row?.ticker || '').trim();
    if (!raw) return '';
    const normalized = this.comparableSymbol(raw, market);
    return market === 'HK' ? normalized.replace(/^0+/, '').padStart(5, '0') : normalized;
  }

  /** Tencent/stock-sdk US codes carry both a `us` prefix and exchange suffix (`NVO.N`). */
  private comparableSymbol(value: string, market: 'A_SHARE' | 'HK' | 'US'): string {
    const raw = value.trim();
    if (market === 'A_SHARE') return raw.replace(/^(sh|sz|bj)/i, '').replace(/\.(SH|SZ|BJ)$/i, '').toUpperCase();
    if (market === 'HK') return raw.replace(/\.HK$/i, '').toUpperCase();
    return raw.replace(/^us/i, '').replace(/\.(?:US|N|O|A|P|AM|PS)$/i, '').toUpperCase();
  }

  private matchesSearchMarket(row: any, symbol: string, market: 'A_SHARE' | 'HK' | 'US'): boolean {
    const hint = String(row?.market || row?.marketType || row?.exchange || '').toUpperCase();
    if (hint) {
      if (market === 'A_SHARE') return /CN|A_SHARE|SH|SZ|BJ/.test(hint);
      if (market === 'HK') return /HK|HONG/.test(hint);
      if (market === 'US') return /US|NASDAQ|NYSE|AMEX/.test(hint);
    }
    if (market === 'A_SHARE') return /^\d{6}$/.test(symbol);
    if (market === 'HK') return /^\d{5}$/.test(symbol);
    return /^[A-Z][A-Z0-9.-]*$/i.test(symbol);
  }

  private toBar(row: any, symbol: string, market: string, startDate: string, endDate: string): HistoricalDailyBar | null {
    const date = String(row?.date || row?.time || '').slice(0, 10);
    const values = [row?.open, row?.high, row?.low, row?.close].map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDate || date > endDate || !values.every(this.isPositive) || values[2] > Math.min(values[0], values[3]) || values[1] < Math.max(values[0], values[3])) return null;
    return {
      id: `${market}:${symbol}:STOCK:${date}`,
      symbol,
      market,
      assetType: 'STOCK',
      date,
      open: values[0], high: values[1], low: values[2], close: values[3],
      volume: this.finiteOrNull(row?.volume),
      provider: this.name,
      adjustmentMode: 'raw',
      fetchedAt: Date.now()
    };
  }

  private isPositive = (value: unknown): boolean => Number.isFinite(Number(value)) && Number(value) > 0;
  private finiteOrNull(value: unknown): number | null { return Number.isFinite(Number(value)) ? Number(value) : null; }
  private skipped<T>(): MarketDataResult<T> { return { ok: true, status: 'skipped', provider: this.name, data: [] as T }; }
  private async started(type: string, symbol: string, market: string): Promise<void> { await logMarketRequest({ providerId: this.name, type: 'request_start', message: `[stock-sdk] 发起 ${type} 请求 (${symbol}, ${market})`, detail: { transport: 'marketFetch' } }); }
  private async succeeded(type: string, count: number, startedAt: number, detail: Record<string, unknown> = {}): Promise<void> { await logMarketRequest({ providerId: this.name, type: 'request_success', message: `[stock-sdk] ${type} 请求成功，${count} 条有效数据`, detail: { durationMs: Date.now() - startedAt, ...detail } }); }
  private async failed(code: string, message: string, startedAt: number): Promise<MarketDataResult<any>> { await logMarketRequest({ providerId: this.name, type: 'request_failed', message: `[stock-sdk] 请求失败 - ${message}`, detail: { errorCode: code, durationMs: Date.now() - startedAt } }); return { ok: false, status: 'failed', provider: this.name, message, errorCode: code, durationMs: Date.now() - startedAt }; }
  private async fromError(error: unknown, startedAt: number): Promise<MarketDataResult<any>> {
    const message = error instanceof Error ? error.message : String(error);
    const cors = /\bcors\b/i.test(message);
    if (/STOCK_SDK_TIMEOUT/.test(message)) {
      return this.failed('SDK_REQUEST_ERROR', 'stock-sdk 请求超时，正在尝试下一个行情源。', startedAt);
    }
    return this.failed(
      cors ? 'CORS_ERROR' : 'NETWORK_UNREACHABLE',
      cors ? '请求受到浏览器跨域限制。' : `stock-sdk 请求未能建立连接，将自动重试：${message}`,
      startedAt,
    ).then(result => ({ ...result, status: cors ? 'cors_error' : 'network_error' }));
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STOCK_SDK_TIMEOUT')), timeoutMs);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }
}
