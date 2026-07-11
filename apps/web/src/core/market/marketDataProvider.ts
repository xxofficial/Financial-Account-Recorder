import { QuoteSnapshot, HistoricalDailyBar } from '../../db/schema';
import { marketFetch, MarketDataResult, requestWithLogging } from './marketRequestHelper';

export interface MarketProviderSecurityInfo {
  symbol: string;
  market: string;
  name: string;
  assetType: 'STOCK' | 'OPTION';
}

export interface MarketDataProvider {
  readonly name: string;
  testConnection(apiKey: string): Promise<MarketDataResult<boolean>>;
  fetchQuotes(
    symbols: { symbol: string; market: string; assetType: 'STOCK' | 'OPTION' }[],
    apiKey: string
  ): Promise<MarketDataResult<QuoteSnapshot[]>>;
  fetchHistoricalBars(
    symbol: string,
    market: string,
    assetType: 'STOCK' | 'OPTION',
    startDate: string,
    endDate: string,
    apiKey: string
  ): Promise<MarketDataResult<HistoricalDailyBar[]>>;
  searchSecurity(symbol: string, market: string, apiKey: string): Promise<MarketDataResult<MarketProviderSecurityInfo | null>>;
  
  // Capability check declarations
  supportsAssetType(assetType: 'STOCK' | 'OPTION'): boolean;
  supportsMarket(market: string): boolean;
}

export class MarketDataAppProvider implements MarketDataProvider {
  readonly name = 'marketdata';

  supportsAssetType(assetType: 'STOCK' | 'OPTION'): boolean {
    const at = (assetType || '').toUpperCase();
    return at === 'STOCK' || at === 'OPTION';
  }

  supportsMarket(market: string): boolean {
    return (market || '').toUpperCase() === 'US';
  }

  private formatOptionSymbol(symbol: string): string {
    const clean = symbol.trim().toUpperCase();
    const noSpaces = clean.replace(/\s+/g, '');
    
    // Check if it's already a standard OCC format (e.g. AAPL260708C00300000)
    const occRegex = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
    if (occRegex.test(noSpaces)) {
      return noSpaces;
    }

    const parts = clean.split(/\s+/);
    
    // If it's like "AAPL260708C300" (no spaces)
    const combinedRegex = /^([A-Z]+)(\d{6})([CP])(\d+(\.\d+)?)$/;
    const combinedMatch = clean.replace(/\s+/g, '').match(combinedRegex);
    if (combinedMatch) {
      const [, underlying, datePart, typeChar, strikePart] = combinedMatch;
      const strikeVal = parseFloat(strikePart);
      if (!isNaN(strikeVal)) {
        const strikeFormatted = Math.round(strikeVal * 1000).toString().padStart(8, '0');
        return `${underlying}${datePart}${typeChar}${strikeFormatted}`;
      }
    }

    // If it has spaces (e.g. "AAPL 260708 300.0 C" or "AAPL 260708 C 300")
    if (parts.length >= 2) {
      const underlying = parts[0];
      const remaining = parts.slice(1);
      
      let datePart = '';
      let typeChar = '';
      let strikeVal: number | null = null;
      
      for (const p of remaining) {
        if (/^\d{6}$/.test(p)) {
          datePart = p;
        } else if (/^[CP]$/.test(p)) {
          typeChar = p;
        } else if (/^\d+(\.\d+)?$/.test(p)) {
          strikeVal = parseFloat(p);
        } else {
          const m1 = p.match(/^([CP])(\d+(\.\d+)?)$/);
          if (m1) {
            typeChar = m1[1];
            strikeVal = parseFloat(m1[2]);
            continue;
          }
          const m2 = p.match(/^(\d{6})([CP])$/);
          if (m2) {
            datePart = m2[1];
            typeChar = m2[2];
            continue;
          }
          const m3 = p.match(/^(\d{6})([CP])(\d+(\.\d+)?)$/);
          if (m3) {
            datePart = m3[1];
            typeChar = m3[2];
            strikeVal = parseFloat(m3[3]);
            continue;
          }
        }
      }
      
      if (datePart && typeChar && strikeVal !== null) {
        const strikeFormatted = Math.round(strikeVal * 1000).toString().padStart(8, '0');
        return `${underlying}${datePart}${typeChar}${strikeFormatted}`;
      }
    }

    return clean.replace(/\s+/g, '');
  }

  async testConnection(apiKey: string): Promise<MarketDataResult<boolean>> {
    if (!apiKey || apiKey.trim() === '') {
      return { ok: false, status: 'provider_unconfigured', provider: this.name, message: 'API Key 未配置' };
    }
    const url = `https://api.marketdata.app/v1/stocks/quotes/AAPL/`;
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
          headers: {
            'Authorization': `Bearer ${apiKey}`
          },
          signal
        });
        return {
          response: res,
          parseData: async (resp) => {
            const data = await resp.json();
            return data.s === 'ok';
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

    const supportedSymbols = symbols.filter(s => this.supportsMarket(s.market) && this.supportsAssetType(s.assetType));
    if (supportedSymbols.length === 0) {
      return { ok: true, status: 'skipped', provider: this.name, data: [] };
    }

    const firstItem = supportedSymbols[0];
    const isOption = firstItem.assetType.toUpperCase() === 'OPTION';
    const endpoint = isOption
      ? (supportedSymbols.length === 1 
          ? `https://api.marketdata.app/v1/options/quotes/${encodeURIComponent(this.formatOptionSymbol(firstItem.symbol))}/`
          : `https://api.marketdata.app/v1/options/quotes/ (batch of ${supportedSymbols.length})`)
      : (supportedSymbols.length === 1 
          ? `https://api.marketdata.app/v1/stocks/quotes/${firstItem.symbol}/`
          : `https://api.marketdata.app/v1/stocks/quotes/ (batch of ${supportedSymbols.length})`);

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

        for (const item of supportedSymbols) {
          let url = '';
          if (item.assetType.toUpperCase() === 'OPTION') {
            const occSymbol = this.formatOptionSymbol(item.symbol);
            url = `https://api.marketdata.app/v1/options/quotes/${encodeURIComponent(occSymbol)}/`;
          } else {
            url = `https://api.marketdata.app/v1/stocks/quotes/${item.symbol}/`;
          }

          const res = await marketFetch(url, {
            headers: {
              'Authorization': `Bearer ${apiKey}`
            },
            signal
          });
          
          lastResponse = res;
          if (!res.ok) continue;

          const json = await res.json();
          if (json.s !== 'ok') continue;

          let currentPrice: number | null = null;
          if (item.assetType.toUpperCase() === 'OPTION') {
            const lastVal = json.last ? (json.last[0] ?? null) : null;
            const midVal = json.mid ? (json.mid[0] ?? null) : null;
            const bidVal = json.bid ? (json.bid[0] ?? null) : null;
            const askVal = json.ask ? (json.ask[0] ?? null) : null;
            currentPrice = lastVal ?? midVal ?? (bidVal !== null && askVal !== null ? (bidVal + askVal) / 2 : null);
          } else {
            if (!json.last || json.last.length === 0) continue;
            currentPrice = json.last[0] ?? null;
          }

          if (currentPrice === null) continue;

          const previousClose = json.prevClose ? (json.prevClose[0] ?? null) : null;
          let change = json.change ? (json.change[0] ?? null) : null;
          let changePercent = json.changePercent ? (json.changePercent[0] ?? null) : null;

          if (item.assetType.toUpperCase() === 'OPTION' && previousClose !== null) {
            change = currentPrice - previousClose;
            changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;
          }

          results.push({
            id: `${item.market}:${item.symbol}`,
            symbol: item.symbol,
            market: item.market,
            name: item.symbol,
            assetType: item.assetType,
            currentPrice,
            previousClose,
            change,
            changePercent,
            currency: 'USD',
            provider: 'marketdata',
            fetchedAt: Date.now()
          });
        }

        return {
          response: lastResponse || new Response(JSON.stringify({ s: 'no_data' }), { status: 400 }),
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
    if (!this.supportsMarket(market) || !this.supportsAssetType(assetType)) {
      return { ok: true, status: 'skipped', provider: this.name, data: [] };
    }

    let url = '';
    if (assetType.toUpperCase() === 'OPTION') {
      const occSymbol = this.formatOptionSymbol(symbol);
      url = `https://api.marketdata.app/v1/options/quotes/${encodeURIComponent(occSymbol)}/?from=${startDate}&to=${endDate}`;
    } else {
      url = `https://api.marketdata.app/v1/stocks/candles/D/${symbol}/?from=${startDate}&to=${endDate}`;
    }

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
            'Authorization': `Bearer ${apiKey}`
          },
          signal
        });
        return {
          response: res,
          parseData: async (resp) => {
            const json = await resp.json();
            if (json.s !== 'ok') return [];

            const bars: HistoricalDailyBar[] = [];

            if (assetType.toUpperCase() === 'OPTION') {
              const updatedArr = json.updated || [];
              const len = updatedArr.length;

              for (let i = 0; i < len; i++) {
                const ts = updatedArr[i];
                let dateStr = '';
                if (typeof ts === 'number') {
                  const dateObj = new Date(ts * 1000);
                  const formatter = new Intl.DateTimeFormat('en-US', {
                    timeZone: 'America/New_York',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                  });
                  const parts = formatter.formatToParts(dateObj);
                  const month = parts.find(p => p.type === 'month')?.value || '01';
                  const day = parts.find(p => p.type === 'day')?.value || '01';
                  const year = parts.find(p => p.type === 'year')?.value || '1970';
                  dateStr = `${year}-${month}-${day}`;
                } else {
                  dateStr = new Date(ts).toISOString().split('T')[0];
                }

                if (dateStr >= startDate && dateStr <= endDate) {
                  const lastVal = json.last ? (json.last[i] ?? null) : null;
                  const midVal = json.mid ? (json.mid[i] ?? null) : null;
                  const bidVal = json.bid ? (json.bid[i] ?? null) : null;
                  const askVal = json.ask ? (json.ask[i] ?? null) : null;
                  const price = lastVal ?? midVal ?? (bidVal !== null && askVal !== null ? (bidVal + askVal) / 2 : null);

                  if (price !== null) {
                    bars.push({
                      id: `${market}:${symbol}:${assetType}:${dateStr}`,
                      symbol,
                      market,
                      assetType,
                      date: dateStr,
                      open: price,
                      high: price,
                      low: price,
                      close: price,
                      volume: json.volume ? (json.volume[i] ?? null) : null,
                      provider: 'marketdata',
                      fetchedAt: Date.now()
                    });
                  }
                }
              }
            } else {
              if (!json.t || !Array.isArray(json.t)) return [];
              const len = json.t.length;
              for (let i = 0; i < len; i++) {
                const timestampSeconds = json.t[i];
                const dateStr = new Date(timestampSeconds * 1000).toISOString().split('T')[0];

                if (dateStr >= startDate && dateStr <= endDate) {
                  bars.push({
                    id: `${market}:${symbol}:${assetType}:${dateStr}`,
                    symbol,
                    market,
                    assetType,
                    date: dateStr,
                    open: json.o ? (json.o[i] ?? null) : null,
                    high: json.h ? (json.h[i] ?? null) : null,
                    low: json.l ? (json.l[i] ?? null) : null,
                    close: json.c[i],
                    volume: json.v ? (json.v[i] ?? null) : null,
                    provider: 'marketdata',
                    fetchedAt: Date.now()
                  });
                }
              }
            }
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

    const url = `https://api.marketdata.app/v1/stocks/quotes/${symbol}/`;
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
            'Authorization': `Bearer ${apiKey}`
          },
          signal
        });
        return {
          response: res,
          parseData: async (resp) => {
            const json = await resp.json();
            if (json.s !== 'ok') return null;
            return {
              symbol,
              market,
              name: symbol,
              assetType: 'STOCK'
            };
          }
        };
      }
    );
  }
}
