import { MarketDataProvider, MarketProviderSecurityInfo } from './marketDataProvider';
import { QuoteSnapshot, HistoricalDailyBar } from '../../db/schema';
import { marketFetch, MarketDataResult, requestWithLogging } from './marketRequestHelper';

export class TwelvedataProvider implements MarketDataProvider {
  readonly name = 'twelvedata';

  supportsAssetType(assetType: 'STOCK' | 'OPTION'): boolean {
    return (assetType || '').toUpperCase() === 'STOCK';
  }

  supportsMarket(market: string): boolean {
    const m = (market || '').toUpperCase();
    return m === 'US' || m === 'HK' || m === 'A_SHARE';
  }

  private formatTicker(symbol: string, market: string): string {
    if (market === 'HK') {
      const clean = symbol.replace(/^0+/, '');
      const padded = clean.padStart(4, '0');
      return `${padded}.HK`;
    }
    return symbol;
  }

  async testConnection(apiKey: string): Promise<MarketDataResult<boolean>> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, status: 'provider_unconfigured', provider: this.name, message: 'API Key 未配置' };
    }
    const url = `https://api.twelvedata.com/quote?symbol=AAPL&apikey=${apiKey}`;
    return requestWithLogging<boolean>(
      this.name,
      'search',
      'AAPL',
      'US',
      'STOCK',
      url,
      10000,
      async (signal) => {
        const res = await marketFetch(url, { signal });
        return {
          response: res,
          parseData: async (resp) => {
            const data = await resp.json();
            return !data.code && data.status !== 'error';
          }
        };
      }
    );
  }

  async fetchQuotes(
    symbols: { symbol: string; market: string; assetType: 'STOCK' | 'OPTION' }[],
    apiKey: string
  ): Promise<MarketDataResult<QuoteSnapshot[]>> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, status: 'provider_unconfigured', provider: this.name, message: '行情源 API Key 未配置' };
    }

    const stocksOnly = symbols.filter(s => (s.assetType || '').toUpperCase() !== 'OPTION' && this.supportsMarket(s.market));
    if (stocksOnly.length === 0) {
      return { ok: true, status: 'skipped', provider: this.name, data: [] };
    }

    const formattedTickers = stocksOnly.map(s => this.formatTicker(s.symbol, s.market));
    const tickersParam = formattedTickers.join(',');
    const url = `https://api.twelvedata.com/quote?symbol=${tickersParam}&apikey=${apiKey}`;

    const firstItem = stocksOnly[0];

    return requestWithLogging<QuoteSnapshot[]>(
      this.name,
      'quote',
      firstItem.symbol,
      firstItem.market,
      firstItem.assetType,
      url,
      10000,
      async (signal) => {
        const res = await marketFetch(url, { signal });
        return {
          response: res,
          parseData: async (resp) => {
            const json = await resp.json();
            const results: QuoteSnapshot[] = [];

            const parseQuoteItem = (itemData: any, originalItem: { symbol: string; market: string }) => {
              if (!itemData || itemData.status === 'error') return;

              const currentPrice = itemData.close ? parseFloat(itemData.close) : (itemData.price ? parseFloat(itemData.price) : null);
              const previousClose = itemData.previous_close ? parseFloat(itemData.previous_close) : null;
              const change = itemData.change ? parseFloat(itemData.change) : null;
              
              let changePercent = null;
              if (itemData.percent_change) {
                changePercent = parseFloat(itemData.percent_change.replace('%', ''));
              }

              results.push({
                id: `${originalItem.market}:${originalItem.symbol}`,
                symbol: originalItem.symbol,
                market: originalItem.market,
                name: itemData.name || originalItem.symbol,
                assetType: 'STOCK',
                currentPrice,
                previousClose,
                change,
                changePercent,
                currency: originalItem.market === 'US' ? 'USD' : originalItem.market === 'HK' ? 'HKD' : 'CNY',
                provider: 'twelvedata',
                fetchedAt: Date.now()
              });
            };

            if (stocksOnly.length === 1) {
              parseQuoteItem(json, stocksOnly[0]);
            } else {
              stocksOnly.forEach((originalItem) => {
                const formatted = this.formatTicker(originalItem.symbol, originalItem.market);
                const itemData = json[formatted];
                parseQuoteItem(itemData, originalItem);
              });
            }

            return results;
          }
        };
      }
    );
  }

  async fetchHistoricalBars(
    symbol: string,
    market: string,
    assetType: 'STOCK' | 'OPTION',
    startDate: string,
    endDate: string,
    apiKey: string
  ): Promise<MarketDataResult<HistoricalDailyBar[]>> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, status: 'provider_unconfigured', provider: this.name, message: '行情源 API Key 未配置' };
    }
    if (assetType.toUpperCase() === 'OPTION' || !this.supportsMarket(market)) {
      return { ok: true, status: 'skipped', provider: this.name, data: [] };
    }

    const ticker = this.formatTicker(symbol, market);
    const url = `https://api.twelvedata.com/time_series?symbol=${ticker}&interval=1day&start_date=${startDate}&end_date=${endDate}&apikey=${apiKey}`;

    return requestWithLogging<HistoricalDailyBar[]>(
      this.name,
      'history',
      symbol,
      market,
      assetType,
      url,
      20000,
      async (signal) => {
        const res = await marketFetch(url, { signal });
        return {
          response: res,
          parseData: async (resp) => {
            const json = await resp.json();
            if (!json.values || !Array.isArray(json.values)) return [];

            const bars: HistoricalDailyBar[] = [];
            json.values.forEach((v: any) => {
              const dateStr = v.datetime;
              if (dateStr >= startDate && dateStr <= endDate) {
                bars.push({
                  id: `${market}:${symbol}:${assetType}:${dateStr}`,
                  symbol,
                  market,
                  assetType: 'STOCK',
                  date: dateStr,
                  open: v.open ? parseFloat(v.open) : null,
                  high: v.high ? parseFloat(v.high) : null,
                  low: v.low ? parseFloat(v.low) : null,
                  close: parseFloat(v.close),
                  volume: v.volume ? parseInt(v.volume, 10) : null,
                  provider: 'twelvedata',
                  fetchedAt: Date.now()
                });
              }
            });
            return bars;
          }
        };
      }
    );
  }

  async searchSecurity(symbol: string, market: string, apiKey: string): Promise<MarketDataResult<MarketProviderSecurityInfo | null>> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, status: 'provider_unconfigured', provider: this.name, message: '行情源 API Key 未配置' };
    }
    if (!this.supportsMarket(market)) {
      return { ok: true, status: 'skipped', provider: this.name, data: null };
    }

    const ticker = this.formatTicker(symbol, market);
    const url = `https://api.twelvedata.com/symbol_search?symbol=${ticker}&apikey=${apiKey}`;

    return requestWithLogging<MarketProviderSecurityInfo | null>(
      this.name,
      'search',
      symbol,
      market,
      'STOCK',
      url,
      8000,
      async (signal) => {
        const res = await marketFetch(url, { signal });
        return {
          response: res,
          parseData: async (resp) => {
            const json = await resp.json();
            if (!json.data || !Array.isArray(json.data) || json.data.length === 0) return null;
            const matched = json.data[0];
            return {
              symbol,
              market,
              name: matched.instrument_name || symbol,
              assetType: 'STOCK'
            };
          }
        };
      }
    );
  }
}
