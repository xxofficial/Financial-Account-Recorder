import { MarketDataProvider, MarketProviderSecurityInfo } from './marketDataProvider';
import { QuoteSnapshot, HistoricalDailyBar } from '../../db/schema';
import { marketFetch, MarketDataResult, requestWithLogging } from './marketRequestHelper';

export class ItickProvider implements MarketDataProvider {
  readonly name = 'itick';

  supportsAssetType(assetType: 'STOCK' | 'OPTION'): boolean {
    return (assetType || '').toUpperCase() === 'STOCK';
  }

  supportsMarket(market: string): boolean {
    const m = (market || '').toUpperCase();
    return m === 'US' || m === 'HK' || m === 'A_SHARE';
  }

  private getRegionAndCode(symbol: string, market: string): { region: string; code: string } {
    let region = 'US';
    let code = symbol;

    if (market === 'HK') {
      region = 'HK';
      code = symbol;
    } else if (market === 'A_SHARE') {
      if (symbol.startsWith('60') || symbol.startsWith('68') || symbol.startsWith('90')) {
        region = 'SH';
      } else if (symbol.startsWith('00') || symbol.startsWith('30') || symbol.startsWith('20')) {
        region = 'SZ';
      } else if (symbol.startsWith('8') || symbol.startsWith('4')) {
        region = 'BJ';
      } else {
        region = 'SH';
      }
      code = symbol;
    }

    return { region, code };
  }

  async testConnection(apiKey: string): Promise<MarketDataResult<boolean>> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, status: 'provider_unconfigured', provider: this.name, message: 'API Key 未配置' };
    }
    const url = `https://api.itick.org/symbol/list?region=US&limit=1`;
    return requestWithLogging<boolean>(
      this.name,
      'search',
      'AAPL',
      'US',
      'STOCK',
      url,
      10000,
      async (signal) => {
        const res = await marketFetch(url, {
          method: 'GET',
          headers: {
            'accept': 'application/json',
            'token': apiKey
          },
          signal
        });
        return {
          response: res,
          parseData: async (resp) => {
            const data = await resp.json();
            return data.code === 0;
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

    const firstItem = stocksOnly[0];
    const { region, code } = this.getRegionAndCode(firstItem.symbol, firstItem.market);
    const endpoint = stocksOnly.length === 1
      ? `https://api.itick.org/stock/quote?region=${region}&code=${code}`
      : `https://api.itick.org/stock/quote (batch of ${stocksOnly.length})`;

    return requestWithLogging<QuoteSnapshot[]>(
      this.name,
      'quote',
      firstItem.symbol,
      firstItem.market,
      firstItem.assetType,
      endpoint,
      10000,
      async (signal) => {
        const results: QuoteSnapshot[] = [];
        let lastResponse: Response | null = null;

        for (const item of stocksOnly) {
          const { region: r, code: c } = this.getRegionAndCode(item.symbol, item.market);
          const url = `https://api.itick.org/stock/quote?region=${r}&code=${c}`;
          
          const res = await marketFetch(url, {
            headers: {
              'accept': 'application/json',
              'token': apiKey
            },
            signal
          });
          
          lastResponse = res;
          if (!res.ok) continue;

          const json = await res.json();
          if (json.code !== 0 || !json.data) continue;

          const d = json.data;
          const currentPrice = d.ld ?? null;
          const previousClose = d.p ?? null;

          results.push({
            id: `${item.market}:${item.symbol}`,
            symbol: item.symbol,
            market: item.market,
            name: d.s || item.symbol,
            assetType: 'STOCK',
            currentPrice,
            previousClose,
            change: d.ch ?? null,
            changePercent: d.chp ?? null,
            currency: item.market === 'US' ? 'USD' : item.market === 'HK' ? 'HKD' : 'CNY',
            provider: 'itick',
            fetchedAt: Date.now()
          });
        }

        return {
          response: lastResponse || new Response(JSON.stringify({ code: -1, msg: 'No request completed' }), { status: 400 }),
          parseData: async () => results
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

    const { region, code } = this.getRegionAndCode(symbol, market);
    const url = `https://api.itick.org/stock/kline?region=${region}&code=${code}&kType=8&limit=1000`;

    return requestWithLogging<HistoricalDailyBar[]>(
      this.name,
      'history',
      symbol,
      market,
      assetType,
      url,
      20000,
      async (signal) => {
        const res = await marketFetch(url, {
          headers: {
            'accept': 'application/json',
            'token': apiKey
          },
          signal
        });
        return {
          response: res,
          parseData: async (resp) => {
            const json = await resp.json();
            if (json.code !== 0 || !Array.isArray(json.data)) return [];

            const bars: HistoricalDailyBar[] = [];
            json.data.forEach((item: any) => {
              const dateStr = new Date(item.t).toISOString().split('T')[0];
              
              if (dateStr >= startDate && dateStr <= endDate) {
                bars.push({
                  id: `${market}:${symbol}:${assetType}:${dateStr}`,
                  symbol,
                  market,
                  assetType: 'STOCK',
                  date: dateStr,
                  open: item.o ?? null,
                  high: item.h ?? null,
                  low: item.l ?? null,
                  close: item.c,
                  volume: item.v ?? null,
                  provider: 'itick',
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

    const { region, code } = this.getRegionAndCode(symbol, market);
    const url = `https://api.itick.org/stock/quote?region=${region}&code=${code}`;

    return requestWithLogging<MarketProviderSecurityInfo | null>(
      this.name,
      'search',
      symbol,
      market,
      'STOCK',
      url,
      8000,
      async (signal) => {
        const res = await marketFetch(url, {
          headers: {
            'accept': 'application/json',
            'token': apiKey
          },
          signal
        });
        return {
          response: res,
          parseData: async (resp) => {
            const json = await resp.json();
            if (json.code !== 0 || !json.data) return null;
            return {
              symbol,
              market,
              name: json.data.s || symbol,
              assetType: 'STOCK'
            };
          }
        };
      }
    );
  }
}
