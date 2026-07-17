import { normalizeSymbol, StockSDK, toTencentSymbol } from 'stock-sdk';

export type MarketProbeStatus =
  | 'success'
  | 'cors_error'
  | 'network_error'
  | 'parse_error'
  | 'empty_data'
  | 'date_missing'
  | 'invalid_ohlc'
  | 'unsupported';

export type MarketProbeCapability =
  | 'quote.cn'
  | 'quote.hk'
  | 'quote.us'
  | 'history.cn'
  | 'history.hk'
  | 'history.us'
  | 'option.us'
  | 'option.cn.index'
  | 'option.cn.etf'
  | 'option.cn.commodity'
  | 'option.cn.cffex'
  | 'option.cn.lhb';

export type StockSdkOptionCapability =
  | 'option.cn.index'
  | 'option.cn.etf'
  | 'option.cn.commodity'
  | 'option.cn.cffex'
  | 'option.cn.lhb';

export interface MarketProbeResult {
  runtime: 'pwa';
  capability: MarketProbeCapability;
  status: MarketProbeStatus;
  ok: boolean;
  symbols: string[];
  range?: { startDate: string; endDate: string; adjust: 'none' };
  barCount?: number;
  message?: string;
  details?: Array<{ symbol: string; status: MarketProbeStatus; barCount?: number; message?: string }>;
  checkedAt: string;
}

export interface MarketProbeReport {
  runtime: 'pwa';
  sdkVersion: '2.4.0';
  checkedAt: string;
  range: { startDate: string; endDate: string; adjust: 'none' };
  capabilities: Partial<Record<MarketProbeCapability, MarketProbeResult>>;
}

export interface StockSdkOptionsPwaReport {
  runtime: 'pwa';
  sdkVersion: '2.4.0';
  checkedAt: string;
  capabilities: Partial<Record<StockSdkOptionCapability, MarketProbeResult>>;
}

export type MassiveProbeCapability =
  | 'metadata.us'
  | 'quote.us.snapshot'
  | 'history.us.raw'
  | 'split.us'
  | 'dividend.us'
  | 'calendar.us'
  | 'option.us.contracts'
  | 'option.us.history'
  | 'option.us.snapshot';

export type MassiveProbeStatus = 'success' | 'unsupported' | 'empty_data' | 'invalid_data' | 'network_error' | 'cors_error' | 'http_error';

export interface MassiveProbeResult {
  runtime: 'pwa';
  capability: MassiveProbeCapability;
  status: MassiveProbeStatus;
  ok: boolean;
  httpStatus?: number;
  sampleCount?: number;
  message?: string;
  checkedAt: string;
}

export interface MassivePwaReport {
  runtime: 'pwa';
  checkedAt: string;
  capabilities: Partial<Record<MassiveProbeCapability, MassiveProbeResult>>;
}

const RANGE = {
  startDate: '20260622',
  endDate: '20260713',
  adjust: 'none' as const,
};

const ALL_CAPABILITIES: MarketProbeCapability[] = [
  'quote.cn', 'quote.hk', 'quote.us', 'history.cn', 'history.hk', 'history.us', 'option.us',
];

/** Convert an A-share code to the Tencent symbol required by cnSimple. */
export function toCnQuoteSymbol(symbol: string): string {
  return toTencentSymbol(normalizeSymbol(symbol, { market: 'CN' }));
}

/** Normalize a US ticker for stock-sdk kline.us. Newer SDK versions resolve
 * raw tickers against the Eastmoney US code catalog; passing a fabricated
 * `105.<ticker>` secid bypasses that resolver and can turn supported symbols
 * such as SPY into an empty result. */
export function toUsHistorySecid(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  return normalized;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validateQuoteRows(rows: unknown, expectedMarket: string, symbols: string[]): void {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty_data');
  for (const symbol of symbols) {
    const row = rows.find((item: any) => item?.market === expectedMarket && String(item?.code ?? item?.symbol ?? '').toUpperCase().includes(symbol.toUpperCase()));
    if (!row || !finitePositive(row.price)) throw new Error(`missing_quote:${symbol}`);
  }
}

function validateBars(rows: unknown, symbol: string): number {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty_data');
  const inRange = rows.filter((bar: any) => bar?.date >= '2026-06-22' && bar?.date <= '2026-07-13');
  if (inRange.length !== rows.length) throw new Error('date_out_of_range');
  if (!inRange.some((bar: any) => bar?.date === '2026-07-13')) throw new Error(`date_missing:${symbol}:2026-07-13`);
  for (const bar of inRange) {
    if (![bar.open, bar.high, bar.low, bar.close].every(finitePositive) || bar.low > bar.open || bar.low > bar.close || bar.high < bar.open || bar.high < bar.close) {
      throw new Error(`invalid_ohlc:${symbol}:${bar.date}`);
    }
  }
  return inRange.length;
}

function validateOptionBars(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty_data');
  for (const bar of rows as any[]) {
    if (typeof bar?.date !== 'string' || ![bar.open, bar.high, bar.low, bar.close].every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('invalid_ohlc');
    }
    if (bar.low > bar.open || bar.low > bar.close || bar.high < bar.open || bar.high < bar.close) {
      throw new Error('invalid_ohlc');
    }
  }
  return rows.length;
}

function classifyError(error: unknown): { status: MarketProbeStatus; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (message === 'empty_data' || lower.includes('无数据')) return { status: 'empty_data', message };
  if (message.startsWith('date_missing')) return { status: 'date_missing', message };
  if (message.startsWith('invalid_ohlc')) return { status: 'invalid_ohlc', message };
  if (message.startsWith('date_out_of_range')) return { status: 'date_missing', message };
  if (lower.includes('parse') || lower.includes('json')) return { status: 'parse_error', message };
  // Browsers intentionally hide the cause of a failed fetch.  Treat it as a
  // transient network failure unless the runtime explicitly names CORS.
  if (lower.includes('cors')) return { status: 'cors_error', message };
  return { status: 'network_error', message };
}

function success(capability: MarketProbeCapability, symbols: string[], extra: Partial<MarketProbeResult> = {}): MarketProbeResult {
  return {
    runtime: 'pwa',
    capability,
    status: 'success',
    ok: true,
    symbols,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

async function runHistory(
  capability: 'history.cn' | 'history.hk' | 'history.us',
  symbols: string[],
  fetchKline: (symbol: string) => Promise<unknown>,
): Promise<MarketProbeResult> {
  const details: MarketProbeResult['details'] = [];
  for (const symbol of symbols) {
    try {
      const rows = await fetchKline(symbol);
      const barCount = validateBars(rows, symbol);
      details.push({ symbol, status: 'success', barCount });
    } catch (error) {
      const classified = classifyError(error);
      details.push({ symbol, status: classified.status, message: classified.message });
    }
  }
  const failed = details.filter((detail) => detail.status !== 'success');
  if (failed.length > 0) {
    return {
      runtime: 'pwa',
      capability,
      status: failed[0].status,
      ok: false,
      symbols,
      range: RANGE,
      details,
      message: failed.map((detail) => `${detail.symbol}: ${detail.message || detail.status}`).join('; '),
      checkedAt: new Date().toISOString(),
    };
  }
  return success(capability, symbols, {
    range: RANGE,
    details,
    barCount: details.reduce((total, detail) => total + (detail.barCount || 0), 0),
  });
}

export async function runStockSdkPwaProbe(selectedCapabilities: MarketProbeCapability[] = ALL_CAPABILITIES): Promise<MarketProbeReport> {
  const sdk = new StockSDK({ fetchImpl: (input, init) => fetch(input, init) });
  const checkedAt = new Date().toISOString();
  const capabilities = {} as MarketProbeReport['capabilities'];
  const selected = new Set(selectedCapabilities);

  const quoteCases: Array<{ capability: 'quote.cn' | 'quote.hk' | 'quote.us'; market: string; symbols: string[]; run: () => Promise<unknown> }> = [
    { capability: 'quote.cn', market: 'CN', symbols: ['600519', '000858'], run: () => sdk.quotes.cnSimple(['600519', '000858'].map(toCnQuoteSymbol)) },
    { capability: 'quote.hk', market: 'HK', symbols: ['07709'], run: () => sdk.quotes.hk(['07709']) },
    { capability: 'quote.us', market: 'US', symbols: ['AAPL', 'SPY', 'QQQ'], run: () => sdk.quotes.us(['AAPL', 'SPY', 'QQQ']) },
  ];

  for (const item of quoteCases.filter((candidate) => selected.has(candidate.capability))) {
    try {
      const rows = await item.run();
      validateQuoteRows(rows, item.market, item.symbols);
      capabilities[item.capability] = success(item.capability, item.symbols);
    } catch (error) {
      const classified = classifyError(error);
      capabilities[item.capability] = {
        runtime: 'pwa', capability: item.capability, status: classified.status, ok: false,
        symbols: item.symbols, message: classified.message, checkedAt,
      };
    }
  }

  if (selected.has('history.cn')) {
    capabilities['history.cn'] = await runHistory('history.cn', ['600519'], (symbol) => sdk.kline.cn(symbol, { period: 'daily', adjust: '', startDate: RANGE.startDate, endDate: RANGE.endDate }));
  }
  if (selected.has('history.hk')) {
    capabilities['history.hk'] = await runHistory('history.hk', ['07709'], (symbol) => sdk.kline.hk(symbol, { period: 'daily', adjust: '', startDate: RANGE.startDate, endDate: RANGE.endDate }));
  }
  if (selected.has('history.us')) {
    capabilities['history.us'] = await runHistory('history.us', ['AAPL', 'SPY', 'QQQ'], (symbol) => sdk.kline.us(toUsHistorySecid(symbol), { period: 'daily', adjust: '', startDate: RANGE.startDate, endDate: RANGE.endDate }));
  }
  if (selected.has('option.us')) {
    capabilities['option.us'] = {
      runtime: 'pwa', capability: 'option.us', status: 'unsupported', ok: false,
      symbols: [], message: 'stock-sdk is not used for US individual options', checkedAt,
    };
  }

  return { runtime: 'pwa', sdkVersion: '2.4.0', checkedAt, range: RANGE, capabilities };
}

/** Test-only probe for stock-sdk's domestic option namespaces. This stays
 * separate from option.us: stock-sdk targets CN index/ETF/commodity/CFFEX
 * products and is not a US individual-option provider. */
export async function runStockSdkOptionsPwaProbe(): Promise<StockSdkOptionsPwaReport> {
  const sdk = new StockSDK({ fetchImpl: (input, init) => fetch(input, init) });
  const checkedAt = new Date().toISOString();
  const capabilities: Partial<Record<StockSdkOptionCapability, MarketProbeResult>> = {};

  const run = async (
    capability: StockSdkOptionCapability,
    symbols: string[],
    action: () => Promise<unknown>,
    validate: (value: unknown) => number,
  ): Promise<void> => {
    try {
      const count = validate(await action());
      capabilities[capability] = {
        runtime: 'pwa', capability, status: 'success', ok: true, symbols, barCount: count, checkedAt,
      };
    } catch (error) {
      const classified = classifyError(error);
      capabilities[capability] = {
        runtime: 'pwa', capability, status: classified.status, ok: false,
        symbols, message: classified.message, checkedAt,
      };
    }
  };

  await run('option.cn.etf', ['10004336'], () => sdk.options.etf.dailyKline('10004336'), validateOptionBars);
  await run('option.cn.index', ['io2504C3600'], () => sdk.options.index.kline('io2504C3600'), validateOptionBars);
  await run('option.cn.commodity', ['au:2610'], () => sdk.options.commodity.spot('au', '2610'), (value: any) => {
    const count = (Array.isArray(value?.calls) ? value.calls.length : 0) + (Array.isArray(value?.puts) ? value.puts.length : 0);
    if (count === 0) throw new Error('empty_data');
    return count;
  });
  await run('option.cn.cffex', ['IO2607-C-4700'], () => sdk.options.cffex.quotes(), (value) => {
    if (!Array.isArray(value) || value.length === 0) throw new Error('empty_data');
    return value.length;
  });
  await run('option.cn.lhb', ['510050:2026-07-13'], () => sdk.options.lhb('510050', '2026-07-13'), (value) => {
    if (!Array.isArray(value) || value.length === 0) throw new Error('empty_data');
    return value.length;
  });

  return { runtime: 'pwa', sdkVersion: '2.4.0', checkedAt, capabilities };
}

const MASSIVE_PROBE_CONTRACT = 'O:AAPL260717C00110000';

function massiveResult(capability: MassiveProbeCapability, status: MassiveProbeStatus, extra: Partial<MassiveProbeResult> = {}): MassiveProbeResult {
  return { runtime: 'pwa', capability, status, ok: status === 'success', checkedAt: new Date().toISOString(), ...extra };
}

async function massiveJson(apiKey: string, path: string): Promise<{ status: number; body: any }> {
  let response: Response;
  try {
    response = await fetch(`https://api.massive.com${path}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.toLowerCase().includes('cors') ? 'cors_error' : 'network_error');
  }
  let body: any = null;
  try { body = await response.json(); } catch { /* status-only responses remain classifiable */ }
  return { status: response.status, body };
}

function validateMassiveBars(body: any): number {
  const rows = body?.results;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('empty_data');
  for (const row of rows) {
    if (![row?.o, row?.h, row?.l, row?.c].every(finitePositive) || row.l > row.o || row.l > row.c || row.h < row.o || row.h < row.c) throw new Error('invalid_data');
  }
  return rows.length;
}

/** Local-only probe; the key is never returned, logged, or persisted. */
export async function runMassivePwaProbe(apiKey: string): Promise<MassivePwaReport> {
  if (!apiKey.trim()) throw new Error('Massive API key is required');
  const capabilities: Partial<Record<MassiveProbeCapability, MassiveProbeResult>> = {};
  const run = async (capability: MassiveProbeCapability, path: string, validate: (body: any) => number | undefined, expectUnsupported = false) => {
    try {
      const response = await massiveJson(apiKey.trim(), path);
      if (expectUnsupported && (response.status === 401 || response.status === 403)) {
        capabilities[capability] = massiveResult(capability, 'unsupported', { httpStatus: response.status, message: '当前订阅不支持此端点' });
        return;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
      const sampleCount = validate(response.body);
      capabilities[capability] = massiveResult(capability, 'success', { httpStatus: response.status, sampleCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status: MassiveProbeStatus = message === 'empty_data' ? 'empty_data' : message === 'invalid_data' ? 'invalid_data' : message === 'cors_error' ? 'cors_error' : message === 'network_error' ? 'network_error' : 'http_error';
      capabilities[capability] = massiveResult(capability, status, { message });
    }
  };

  await run('metadata.us', '/v3/reference/tickers/AAPL', body => {
    if (body?.status !== 'OK' || body?.results?.ticker !== 'AAPL' || !body?.results?.name) throw new Error('invalid_data');
    return 1;
  });
  await run('quote.us.snapshot', '/v2/snapshot/locale/us/markets/stocks/tickers/AAPL', body => {
    if (!body?.ticker && !body?.status) throw new Error('invalid_data');
    return 1;
  }, true);
  await run('history.us.raw', '/v2/aggs/ticker/AAPL/range/1/day/2026-06-01/2026-06-05?adjusted=false', validateMassiveBars);
  await run('split.us', '/stocks/v1/splits?ticker=SNXX&limit=10', body => {
    const rows = body?.results;
    if (!Array.isArray(rows) || !rows.some((row: any) => row.ticker === 'SNXX' && row.execution_date === '2026-06-03' && Number(row.split_from) === 1 && Number(row.split_to) === 8)) throw new Error('invalid_data');
    return rows.length;
  });
  await run('dividend.us', '/stocks/v1/dividends?ticker=AAPL&limit=1', body => {
    if (!Array.isArray(body?.results) || !body.results[0]?.ticker || typeof body.results[0]?.cash_amount !== 'number') throw new Error('invalid_data');
    return body.results.length;
  });
  await run('calendar.us', '/v1/marketstatus/now', body => {
    if (typeof body?.market !== 'string' || !body?.exchanges || typeof body?.serverTime !== 'string') throw new Error('invalid_data');
    return 1;
  });
  await run('option.us.contracts', '/v3/reference/options/contracts?underlying_ticker=AAPL&limit=1', body => {
    if (!Array.isArray(body?.results) || !body.results[0]?.ticker || body.results[0]?.underlying_ticker !== 'AAPL') throw new Error('invalid_data');
    return body.results.length;
  });
  await run('option.us.history', `/v2/aggs/ticker/${encodeURIComponent(MASSIVE_PROBE_CONTRACT)}/range/1/day/2026-07-14/2026-07-16?adjusted=false`, validateMassiveBars);
  await run('option.us.snapshot', `/v3/snapshot/options/AAPL/${encodeURIComponent(MASSIVE_PROBE_CONTRACT)}`, body => {
    if (!body?.results) throw new Error('invalid_data');
    return 1;
  }, true);
  return { runtime: 'pwa', checkedAt: new Date().toISOString(), capabilities };
}

export function installStockSdkPwaProbe(): void {
  window.__RECORDER_STOCK_SDK_PWA_PROBE__ = runStockSdkPwaProbe;
  window.__RECORDER_STOCK_SDK_OPTIONS_PWA_PROBE__ = runStockSdkOptionsPwaProbe;
  window.__RECORDER_MASSIVE_PWA_PROBE__ = runMassivePwaProbe;
}

declare global {
  interface Window {
    __RECORDER_STOCK_SDK_PWA_PROBE__?: (selectedCapabilities?: MarketProbeCapability[]) => Promise<MarketProbeReport>;
    __RECORDER_STOCK_SDK_OPTIONS_PWA_PROBE__?: () => Promise<StockSdkOptionsPwaReport>;
    __RECORDER_MASSIVE_PWA_PROBE__?: (apiKey: string) => Promise<MassivePwaReport>;
  }
}
