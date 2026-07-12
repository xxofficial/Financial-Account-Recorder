import type { HistoricalDailyBar, QuoteSnapshot } from '../../db/schema';
import { nativeMarketFetch } from '../../platform/nativeRuntime';
import type { MarketDataProvider, MarketProviderSecurityInfo } from './marketDataProvider';
import { requestWithLogging, type MarketDataResult } from './marketRequestHelper';

type SecurityRequest = { symbol: string; market: string; assetType: 'STOCK' | 'OPTION' };

const REQUEST_HEADERS = {
  Referer: 'https://gu.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Safari/537.36',
};

// Tencent rejects history requests above 800 rows with `code: 1, msg: bad params`.
const TENCENT_HISTORY_MAX_ROWS = 800;

function tencentCode(item: SecurityRequest): string | null {
  const symbol = item.symbol.split('.')[0];
  if (item.market === 'A_SHARE') return `${symbol.startsWith('6') ? 'sh' : 'sz'}${symbol}`;
  if (item.market === 'HK') return `hk${symbol.padStart(5, '0')}`;
  return null;
}

function sinaCode(item: SecurityRequest): string | null {
  const symbol = item.symbol.split('.')[0];
  if (item.market === 'A_SHARE') return `${symbol.startsWith('6') ? 'sh' : 'sz'}${symbol}`;
  if (item.market === 'HK') return `hk${symbol.padStart(5, '0')}`;
  if (item.market === 'US') return `gb_${symbol.toLowerCase()}`;
  return null;
}

function quote(item: SecurityRequest, name: string, currentPrice: number, previousClose: number, provider: string): QuoteSnapshot {
  return {
    id: `${item.market}:${item.symbol}`,
    symbol: item.symbol,
    market: item.market,
    name: name || item.symbol,
    assetType: item.assetType,
    currentPrice,
    previousClose,
    change: currentPrice - previousClose,
    changePercent: previousClose === 0 ? 0 : ((currentPrice - previousClose) / previousClose) * 100,
    currency: item.market === 'US' ? 'USD' : item.market === 'HK' ? 'HKD' : 'CNY',
    provider,
    fetchedAt: Date.now(),
    requestStatus: 'success',
  };
}

function toYahooOptionSymbol(symbol: string): string | null {
  const compact = symbol.trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]+\d{6}[CP]\d{8}$/.test(compact)) return compact;
  const match = compact.match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}${Math.round(Number(match[4]) * 1000).toString().padStart(8, '0')}`;
}

function dateInNewYork(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp * 1000));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Android-only, keyless default source. It retains the existing app's verified
 * Tencent → Sina stock path and Yahoo option path while the web keeps opt-in APIs.
 */
export class AndroidDefaultMarketProvider implements MarketDataProvider {
  readonly name = 'android-default';

  supportsAssetType(assetType: 'STOCK' | 'OPTION') { return assetType === 'STOCK' || assetType === 'OPTION'; }
  supportsMarket(market: string) { return market === 'A_SHARE' || market === 'HK' || market === 'US'; }
  async testConnection(): Promise<MarketDataResult<boolean>> {
    return { ok: true, status: 'success', provider: this.name, data: true, message: 'Android 默认行情源已启用' };
  }

  async fetchQuotes(requests: SecurityRequest[]): Promise<MarketDataResult<QuoteSnapshot[]>> {
    const stocks = requests.filter((item) => item.assetType === 'STOCK' && this.supportsMarket(item.market));
    const options = requests.filter((item) => item.assetType === 'OPTION' && item.market === 'US');
    const [stockResult, optionResult] = await Promise.all([this.fetchStockQuotes(stocks), this.fetchYahooOptions(options)]);
    const data = [...(stockResult.data ?? []), ...(optionResult.data ?? [])];
    return {
      ok: data.length > 0 || requests.length === 0,
      status: data.length > 0 ? 'success' : (stockResult.status === 'success' ? optionResult.status : stockResult.status),
      provider: this.name,
      data,
      message: stockResult.message ?? optionResult.message,
    };
  }

  private async fetchStockQuotes(items: SecurityRequest[]): Promise<MarketDataResult<QuoteSnapshot[]>> {
    if (items.length === 0) return { ok: true, status: 'skipped', provider: this.name, data: [] };
    const primaryItems = items.filter((item) => tencentCode(item));
    const primary = primaryItems.length === 0
      ? { ok: true, status: 'skipped' as const, provider: this.name, data: [] as QuoteSnapshot[] }
      : await requestWithLogging<QuoteSnapshot[]>(
        'tencent', 'quote', primaryItems.map((item) => item.symbol).join(','), 'MULTI', 'STOCK',
        'https://qt.gtimg.cn/q=', 10_000,
        async () => {
          const codeMap = new Map(primaryItems.map((item) => [tencentCode(item)!, item]));
          const response = await nativeMarketFetch(`https://qt.gtimg.cn/q=${Array.from(codeMap.keys()).join(',')}`, { headers: REQUEST_HEADERS, charset: 'GB18030' });
          return { response, parseData: async (resp) => this.parseTencentQuotes(await resp.text(), codeMap) };
        },
      );
    const missing = items.filter((item) => !(primary.data ?? []).some((result) => result.id === `${item.market}:${item.symbol}`));
    if (missing.length === 0) return { ...primary, provider: this.name };
    const fallback = await requestWithLogging<QuoteSnapshot[]>(
      'sina', 'quote', missing.map((item) => item.symbol).join(','), 'MULTI', 'STOCK',
      'http://hq.sinajs.cn/list=', 10_000,
      async () => {
        const codeMap = new Map(missing.map((item) => [sinaCode(item), item]).filter((pair): pair is [string, SecurityRequest] => pair[0] !== null));
        const response = await nativeMarketFetch(`http://hq.sinajs.cn/list=${Array.from(codeMap.keys()).join(',')}`, { headers: { ...REQUEST_HEADERS, Referer: 'https://finance.sina.com.cn/' }, charset: 'GB18030' });
        return { response, parseData: async (resp) => this.parseSinaQuotes(await resp.text(), codeMap) };
      },
    );
    const data = [...(primary.data ?? []), ...(fallback.data ?? [])];
    return { ok: data.length > 0, status: data.length ? 'success' : fallback.status, provider: this.name, data, message: fallback.message };
  }

  private parseTencentQuotes(body: string, codeMap: Map<string, SecurityRequest>): QuoteSnapshot[] {
    return body.split(/\r?\n/).flatMap((line) => {
      const code = line.split('v_')[1]?.split('=')[0]?.trim() ?? '';
      const item = codeMap.get(code);
      const parts = line.split('="')[1]?.replace(/"\s*;?\s*$/, '').split('~') ?? [];
      const current = Number(parts[3]);
      const previous = Number(parts[4]);
      if (!item || !Number.isFinite(current) || !Number.isFinite(previous)) return [];
      return [quote(item, parts[1] ?? item.symbol, current, previous, 'tencent')];
    });
  }

  private parseSinaQuotes(body: string, codeMap: Map<string, SecurityRequest>): QuoteSnapshot[] {
    return body.split(/\r?\n/).flatMap((line) => {
      const code = line.split('hq_str_')[1]?.split('=')[0]?.trim() ?? '';
      const item = codeMap.get(code);
      const fields = line.split('="')[1]?.replace(/"\s*;?\s*$/, '').split(',') ?? [];
      if (!item) return [];
      const [nameIndex, currentIndex, previousIndex] = item.market === 'HK' ? [1, 6, 3] : item.market === 'US' ? [0, 1, 26] : [0, 3, 2];
      const current = Number(fields[currentIndex]);
      const previous = Number(fields[previousIndex]);
      if (!Number.isFinite(current) || !Number.isFinite(previous)) return [];
      return [quote(item, fields[nameIndex] ?? item.symbol, current, previous, 'sina')];
    });
  }

  private async fetchYahooOptions(items: SecurityRequest[]): Promise<MarketDataResult<QuoteSnapshot[]>> {
    const symbols = items.flatMap((item) => {
      const value = toYahooOptionSymbol(item.symbol);
      return value ? [{ item, yahooSymbol: value }] : [];
    });
    if (symbols.length === 0) return { ok: true, status: 'skipped', provider: this.name, data: [] };
    const primary = await requestWithLogging<QuoteSnapshot[]>(
      'yahoo', 'quote', symbols.map((entry) => entry.yahooSymbol).join(','), 'US', 'OPTION', 'https://query2.finance.yahoo.com/v7/finance/quote', 12_000,
      async () => {
        const response = await nativeMarketFetch(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.map((entry) => entry.yahooSymbol).join(','))}`, { headers: REQUEST_HEADERS });
        return {
          response,
          parseData: async (resp) => {
            const records = (await resp.json()).quoteResponse?.result ?? [];
            return symbols.flatMap(({ item, yahooSymbol }) => {
              const record = records.find((candidate: { symbol?: string }) => candidate.symbol === yahooSymbol);
              const current = Number(record?.regularMarketPrice);
              const previous = Number(record?.regularMarketPreviousClose);
              return Number.isFinite(current) && Number.isFinite(previous)
                ? [quote(item, record.shortName ?? item.symbol, current, previous, 'yahoo')]
                : [];
            });
          },
        };
      },
    );
    const primaryData = primary.data ?? [];
    const missing = symbols.filter(({ item }) => !primaryData.some((snapshot) => snapshot.id === `${item.market}:${item.symbol}`));
    if (missing.length === 0) return primary;

    // The quote API requires a Yahoo crumb. The Android transport refreshes it
    // in native memory, but a proxy can still reject that short request. Chart
    // metadata is keyless and carries last/previous-close fields, making it a
    // safe read-only fallback for option quotes.
    const fallbacks = await Promise.all(missing.map((entry) => this.fetchYahooChartQuote(entry.item, entry.yahooSymbol)));
    const fallbackData = fallbacks.flatMap((result) => result.data ?? []);
    const data = [...primaryData, ...fallbackData];
    const fallbackFailure = fallbacks.find((result) => !result.ok);
    return {
      ok: data.length > 0,
      status: data.length > 0 ? 'success' : (primary.status === 'success' ? fallbackFailure?.status ?? 'failed' : primary.status),
      provider: this.name,
      data,
      message: fallbackFailure?.message ?? primary.message,
    };
  }

  private async fetchYahooChartQuote(item: SecurityRequest, yahooSymbol: string): Promise<MarketDataResult<QuoteSnapshot[]>> {
    const end = Math.floor(Date.now() / 1000) + 86_400;
    const start = end - 7 * 86_400;
    const endpoint = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${start}&period2=${end}&interval=1d`;
    return requestWithLogging<QuoteSnapshot[]>(
      'yahoo', 'quote', item.symbol, 'US', 'OPTION', endpoint, 12_000,
      async () => {
        const response = await nativeMarketFetch(endpoint, { headers: REQUEST_HEADERS });
        return {
          response,
          parseData: async (resp) => {
            const result = (await resp.json()).chart?.result?.[0];
            const meta = result?.meta ?? {};
            const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close ?? [];
            const lastClose = [...closes].reverse().find((value) => Number.isFinite(value));
            const current = Number(meta.regularMarketPrice ?? lastClose);
            const previous = Number(meta.previousClose ?? meta.chartPreviousClose ?? lastClose);
            if (!Number.isFinite(current) || !Number.isFinite(previous)) return [];
            return [quote(item, String(meta.longName ?? meta.shortName ?? item.symbol), current, previous, 'yahoo-chart-fallback')];
          },
        };
      },
    );
  }

  async fetchHistoricalBars(symbol: string, market: string, assetType: 'STOCK' | 'OPTION', startDate: string, endDate: string): Promise<MarketDataResult<HistoricalDailyBar[]>> {
    if (assetType === 'OPTION') return this.fetchYahooHistory(symbol, startDate, endDate);
    if (!this.supportsMarket(market)) return { ok: true, status: 'skipped', provider: this.name, data: [] };
    const raw = symbol.split('.')[0];
    const historyCode = market === 'A_SHARE' ? `${raw.startsWith('6') ? 'sh' : 'sz'}${raw}` : market === 'HK' ? `hk${raw.padStart(5, '0')}` : `us${raw.toUpperCase()}`;
    return requestWithLogging<HistoricalDailyBar[]>(
      'tencent', 'history', symbol, market, assetType, 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get', 15_000,
      async () => {
        const endpoint = market === 'HK' ? 'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get' : 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
        const response = await nativeMarketFetch(`${endpoint}?param=${historyCode},day,,,${TENCENT_HISTORY_MAX_ROWS},qfq`, { headers: REQUEST_HEADERS });
        return { response, parseData: async (resp) => this.parseTencentHistory(await resp.json(), symbol, market, assetType, startDate, endDate) };
      },
    );
  }

  private parseTencentHistory(json: { code?: number; msg?: string; data?: Record<string, { qfqday?: unknown[][]; day?: unknown[][] }> }, symbol: string, market: string, assetType: 'STOCK' | 'OPTION', start: string, end: string): HistoricalDailyBar[] {
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(`腾讯行情接口返回错误${json.msg ? `: ${json.msg}` : ''}`);
    }
    const payload = json.data && Object.values(json.data)[0];
    const rows = payload?.qfqday ?? payload?.day ?? [];
    return rows.flatMap((row) => {
      const date = String(row[0] ?? '');
      const close = Number(row[2]);
      if (date < start || date > end || !Number.isFinite(close)) return [];
      return [{ id: `${market}:${symbol}:${assetType}:${date}`, symbol, market, assetType, date, open: Number(row[1]) || close, high: Number(row[3]) || close, low: Number(row[4]) || close, close, volume: Number(row[5]) || null, provider: 'tencent', fetchedAt: Date.now() }];
    });
  }

  private async fetchYahooHistory(symbol: string, startDate: string, endDate: string): Promise<MarketDataResult<HistoricalDailyBar[]>> {
    const option = toYahooOptionSymbol(symbol);
    if (!option) return { ok: true, status: 'skipped', provider: this.name, data: [] };
    const from = Math.floor(new Date(`${startDate}T00:00:00Z`).getTime() / 1000);
    const to = Math.floor(new Date(`${endDate}T23:59:59Z`).getTime() / 1000);
    return requestWithLogging<HistoricalDailyBar[]>(
      'yahoo', 'history', symbol, 'US', 'OPTION', 'https://query2.finance.yahoo.com/v8/finance/chart', 15_000,
      async () => {
        const response = await nativeMarketFetch(`https://query2.finance.yahoo.com/v8/finance/chart/${option}?period1=${from}&period2=${to}&interval=1d`, { headers: REQUEST_HEADERS });
        return {
          response,
          parseData: async (resp) => {
            const result = (await resp.json()).chart?.result?.[0];
            const timestamps: number[] = result?.timestamp ?? [];
            const values: Array<number | null> = result?.indicators?.quote?.[0]?.close ?? [];
            return timestamps.flatMap((timestamp, index) => {
              const close = values[index];
              if (close === null || !Number.isFinite(close)) return [];
              const date = dateInNewYork(timestamp);
              return [{ id: `US:${symbol}:OPTION:${date}`, symbol, market: 'US', assetType: 'OPTION' as const, date, open: close, high: close, low: close, close, volume: null, provider: 'yahoo', fetchedAt: Date.now() }];
            });
          },
        };
      },
    );
  }

  async searchSecurity(symbol: string, market: string): Promise<MarketDataResult<MarketProviderSecurityInfo | null>> {
    if (!this.supportsMarket(market)) return { ok: true, status: 'skipped', provider: this.name, data: null };
    const endpoint = `http://suggest3.sinajs.cn/suggest/type=11,12,31,41&key=${encodeURIComponent(symbol)}&name=suggestdata`;
    return requestWithLogging<MarketProviderSecurityInfo | null>(
      'sina', 'search', symbol, market, 'STOCK', endpoint, 10_000,
      async () => {
        const response = await nativeMarketFetch(endpoint, { headers: { ...REQUEST_HEADERS, Referer: 'https://finance.sina.com.cn/' }, charset: 'GB18030' });
        return {
          response,
          parseData: async (resp) => {
            const payload = (await resp.text()).split('="')[1]?.replace(/"\s*;?\s*$/, '') ?? '';
            const row = payload.split(';').map((item) => item.split(',')).find((fields) => {
              const type = fields[1];
              return (market === 'A_SHARE' && (type === '11' || type === '12')) || (market === 'HK' && type === '31') || (market === 'US' && type === '41');
            });
            if (!row) return null;
            return { symbol: market === 'US' ? row[2].toUpperCase() : row[2], name: row[4] || row[2], market, assetType: 'STOCK' as const };
          },
        };
      },
    );
  }
}
