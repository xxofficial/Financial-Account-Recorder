import type { HistoricalDailyBar, QuoteSnapshot } from '../../db/schema';
import { marketFetch, MarketDataResult, requestWithLogging } from './marketRequestHelper';
import type { MarketDataProvider, MarketProviderSecurityInfo } from './marketDataProvider';

type MassiveAsset = 'STOCK' | 'OPTION';

/** Massive Stocks API provider. Web-only: its key is kept in browser-local settings. */
export class MassiveProvider implements MarketDataProvider {
  readonly name = 'massive';

  supportsAssetType(assetType: MassiveAsset): boolean {
    return assetType === 'STOCK' || assetType === 'OPTION';
  }

  supportsMarket(market: string): boolean {
    return market.toUpperCase() === 'US';
  }

  async testConnection(apiKey: string): Promise<MarketDataResult<boolean>> {
    if (!apiKey.trim()) return this.unconfigured();
    return requestWithLogging<boolean>(this.name, 'search', 'AAPL', 'US', 'STOCK', 'https://api.massive.com/v3/reference/tickers/AAPL', 10_000, async (signal) => {
      const response = await marketFetch('https://api.massive.com/v3/reference/tickers/AAPL', {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey.trim()}` }, signal,
      });
      return { response, parseData: async (res) => {
        const body = await res.json();
        if (body?.status !== 'OK' || body?.results?.ticker !== 'AAPL') throw new Error('Massive 返回的证券资料无效');
        return true;
      } };
    });
  }

  async fetchQuotes(_symbols: { symbol: string; market: string; assetType: MassiveAsset }[], _apiKey: string): Promise<MarketDataResult<QuoteSnapshot[]>> {
    // The current Massive subscription returns 403 for snapshot endpoints.
    // Do not advertise this provider as a realtime quote source.
    return { ok: true, status: 'skipped', provider: this.name, data: [] };
  }

  async fetchHistoricalBars(symbol: string, market: string, assetType: MassiveAsset, startDate: string, endDate: string, apiKey: string): Promise<MarketDataResult<HistoricalDailyBar[]>> {
    if (!apiKey.trim()) return this.unconfigured();
    if (!this.supportsMarket(market) || !this.supportsAssetType(assetType)) return { ok: true, status: 'skipped', provider: this.name, data: [] };
    const ticker = assetType === 'OPTION' ? this.optionTicker(symbol) : symbol.trim().toUpperCase();
    const encodedTicker = encodeURIComponent(ticker);
    const url = `https://api.massive.com/v2/aggs/ticker/${encodedTicker}/range/1/day/${startDate}/${endDate}?adjusted=false`;
    return requestWithLogging<HistoricalDailyBar[]>(this.name, 'history', symbol, market, assetType, url, 20_000, async (signal) => {
      const response = await marketFetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey.trim()}` }, signal,
      });
      return { response, parseData: async (res) => {
        const body = await res.json();
        const rows = Array.isArray(body?.results) ? body.results : [];
        return rows.map((row: any) => this.toBar(row, symbol, market, assetType, startDate, endDate)).filter((bar: HistoricalDailyBar | null): bar is HistoricalDailyBar => bar !== null);
      } };
    });
  }

  async searchSecurity(symbol: string, market: string, apiKey: string): Promise<MarketDataResult<MarketProviderSecurityInfo | null>> {
    if (!apiKey.trim()) return this.unconfigured<MarketProviderSecurityInfo | null>();
    if (!this.supportsMarket(market)) return { ok: true, status: 'skipped', provider: this.name, data: null };
    const normalized = symbol.trim().toUpperCase();
    const url = `https://api.massive.com/v3/reference/tickers/${encodeURIComponent(normalized)}`;
    return requestWithLogging<MarketProviderSecurityInfo | null>(this.name, 'search', normalized, market, 'STOCK', url, 10_000, async (signal) => {
      const response = await marketFetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey.trim()}` }, signal });
      return { response, parseData: async (res) => {
        const body = await res.json();
        const row = body?.results;
        return row?.ticker && row?.name ? { symbol: row.ticker, market: 'US', name: row.name, assetType: 'STOCK' as const } : null;
      } };
    });
  }

  suggestSecurities(_query: string, market: string, _apiKey: string, _limit: number): Promise<MarketDataResult<MarketProviderSecurityInfo[]>> {
    if (!this.supportsMarket(market)) return Promise.resolve({ ok: true, status: 'skipped', provider: this.name, data: [] });
    return Promise.resolve({ ok: true, status: 'skipped', provider: this.name, data: [] });
  }

  private optionTicker(symbol: string): string {
    const clean = symbol.trim().toUpperCase();
    return clean.startsWith('O:') ? clean : `O:${clean}`;
  }

  private toBar(row: any, symbol: string, market: string, assetType: MassiveAsset, startDate: string, endDate: string): HistoricalDailyBar | null {
    const date = this.tradeDate(Number(row?.t));
    const values = [row?.o, row?.h, row?.l, row?.c].map(Number);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startDate || date > endDate || !values.every(value => Number.isFinite(value) && value > 0) || values[2] > Math.min(values[0], values[3]) || values[1] < Math.max(values[0], values[3])) return null;
    return {
      id: `${market}:${symbol}:${assetType}:${date}`,
      symbol,
      market,
      assetType,
      date,
      open: values[0], high: values[1], low: values[2], close: values[3],
      volume: Number.isFinite(Number(row?.v)) ? Number(row.v) : null,
      provider: this.name,
      adjustmentMode: 'raw',
      fetchedAt: Date.now(),
    };
  }

  private tradeDate(timestamp: number): string {
    if (!Number.isFinite(timestamp)) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
    const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return value.year && value.month && value.day ? `${value.year}-${value.month}-${value.day}` : '';
  }

  private unconfigured<T = HistoricalDailyBar[]>(): MarketDataResult<T> {
    return { ok: false, status: 'provider_unconfigured', provider: this.name, message: 'Massive API Key 未配置' };
  }
}
