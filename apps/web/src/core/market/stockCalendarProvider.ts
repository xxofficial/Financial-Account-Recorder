import { StockSDK } from 'stock-sdk';
import { db } from '../../db/localDb';
import { marketFetch } from '../../platform/nativeRuntime';

export type CalendarMarket = 'A_SHARE' | 'HK' | 'US';

export interface StockCalendarRecord {
  market: CalendarMarket;
  year: number;
  closedDates: string[];
  tradingDates: string[];
  coveredThrough?: string;
}

export interface StockCalendarCache {
  provider: 'stock-sdk';
  fetchedAt: number;
  records: StockCalendarRecord[];
  lastError?: string;
  lastAttemptAt?: number;
}

export interface DailyKlineClient {
  dates(market: Exclude<CalendarMarket, 'A_SHARE'>, symbol: string, startDate: string, endDate: string): Promise<string[]>;
}

export const STOCK_CALENDAR_CACHE_KEY = 'stock_calendar_cache_v1';
const LEGACY_ITICK_KEYS = ['itick_calendar_api_token', 'itick_calendar_cache_v1'];
const MARKETS = ['HK', 'US'] as const;
const ANCHOR_SYMBOLS: Record<typeof MARKETS[number], string[]> = {
  HK: ['00700', '00941'],
  US: ['SPY', 'QQQ'],
};
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
let syncInFlight: Promise<StockCalendarCache> | undefined;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function isWeekday(value: string): boolean {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let current = start; current <= end; current = addDays(current, 1)) dates.push(current);
  return dates;
}

function rowDate(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = (row as { date?: unknown; tradeDate?: unknown; time?: unknown }).date
    ?? (row as { tradeDate?: unknown }).tradeDate
    ?? (row as { time?: unknown }).time;
  if (typeof value === 'string') {
    const match = value.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
    return match?.[0].replaceAll('/', '-');
  }
  return undefined;
}

function createDefaultKlineClient(): DailyKlineClient {
  const sdk = new StockSDK({ fetchImpl: (input: any, init?: any) => marketFetch(input, init) as any });
  return {
    async dates(market, symbol, startDate, endDate) {
      const options = { period: 'daily', startDate, endDate, adjust: '' } as any;
      const rows: unknown[] = market === 'HK'
        ? await sdk.kline.hk(symbol, options)
        : await sdk.kline.us(symbol, options);
      const dates = rows.map(rowDate).filter((value): value is string => Boolean(value));
      return Array.from(new Set(dates.filter((value) => value >= startDate && value <= endDate))).sort();
    },
  };
}

function readCache(value: unknown): StockCalendarCache | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<StockCalendarCache>;
  if (candidate.provider !== 'stock-sdk' || !Array.isArray(candidate.records)) return undefined;
  return {
    provider: 'stock-sdk',
    fetchedAt: Number(candidate.fetchedAt) || 0,
    records: candidate.records.filter((record): record is StockCalendarRecord => Boolean(
      record && typeof record === 'object'
      && MARKETS.includes((record as StockCalendarRecord).market as typeof MARKETS[number])
      && Number.isInteger((record as StockCalendarRecord).year)
      && Array.isArray((record as StockCalendarRecord).closedDates)
      && Array.isArray((record as StockCalendarRecord).tradingDates),
    )),
    lastError: typeof candidate.lastError === 'string' ? candidate.lastError : undefined,
    lastAttemptAt: Number(candidate.lastAttemptAt) || undefined,
  };
}

function emptyCache(): StockCalendarCache {
  return { provider: 'stock-sdk', fetchedAt: 0, records: [] };
}

async function getCache(): Promise<StockCalendarCache> {
  const setting = await db.appSettings.get(STOCK_CALENDAR_CACHE_KEY);
  return readCache(setting?.value) ?? emptyCache();
}

async function saveCache(cache: StockCalendarCache): Promise<void> {
  await db.appSettings.put({ key: STOCK_CALENDAR_CACHE_KEY, value: cache, updatedAt: Date.now() });
}

async function clearLegacyItickSettings(): Promise<void> {
  await db.appSettings.bulkDelete(LEGACY_ITICK_KEYS);
}

function rebuildRecord(existing: StockCalendarRecord | undefined, market: typeof MARKETS[number], year: number, coveredThrough: string, dates: string[]): StockCalendarRecord {
  const tradingDates = Array.from(new Set([...(existing?.tradingDates ?? []), ...dates])).filter((date) => date.startsWith(`${year}-`)).sort();
  const weekdays = dateRange(`${year}-01-01`, coveredThrough).filter(isWeekday);
  return {
    market,
    year,
    tradingDates,
    closedDates: weekdays.filter((date) => !tradingDates.includes(date)),
    coveredThrough,
  };
}

async function fetchMarketDates(client: DailyKlineClient, market: typeof MARKETS[number], startDate: string, endDate: string): Promise<{ dates: string[]; warnings: string[] }> {
  const results = await Promise.allSettled(ANCHOR_SYMBOLS[market].map((symbol) => client.dates(market, symbol, startDate, endDate)));
  const dates = new Set<string>();
  const warnings: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') result.value.forEach((date) => dates.add(date));
    else warnings.push(`${market} ${ANCHOR_SYMBOLS[market][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  if (!dates.size && dateRange(startDate, endDate).some(isWeekday)) {
    throw new Error(warnings.join('; ') || `${market} 日K响应为空`);
  }
  return { dates: Array.from(dates).sort(), warnings: dates.size ? warnings : [] };
}

export class StockCalendarProvider {
  private readonly client: DailyKlineClient;
  private readonly clock: () => number;

  constructor(client = createDefaultKlineClient(), clock = () => Date.now()) {
    this.client = client;
    this.clock = clock;
  }

  private async ensureYear(year: number, force = false): Promise<StockCalendarCache> {
    const now = this.clock();
    const currentYear = new Date(now).getUTCFullYear();
    if (year > currentYear) return getCache();
    const targetEnd = year === currentYear ? addDays(dateOnly(new Date(now)), -1) : `${year}-12-31`;
    if (targetEnd < `${year}-01-01`) return getCache();

    const existing = await getCache();
    const existingRecords = new Map(existing.records.map((record) => [`${record.market}:${record.year}`, record]));
    const needs = MARKETS.filter((market) => {
      const record = existingRecords.get(`${market}:${year}`);
      return force || !record?.coveredThrough || record.coveredThrough < targetEnd;
    });
    if (!needs.length && !existing.lastError) return existing;
    if (!force && existing.lastAttemptAt && now - existing.lastAttemptAt < RETRY_INTERVAL_MS) return existing;

    const failures: string[] = [];
    const warnings: string[] = [];
    await Promise.all(needs.map(async (market) => {
      const current = existingRecords.get(`${market}:${year}`);
      const startDate = force || !current?.coveredThrough ? `${year}-01-01` : addDays(current.coveredThrough, 1);
      try {
        const result = await fetchMarketDates(this.client, market, startDate, targetEnd);
        existingRecords.set(`${market}:${year}`, rebuildRecord(current, market, year, targetEnd, result.dates));
        warnings.push(...result.warnings);
      } catch (error) {
        failures.push(error instanceof Error ? `${market}: ${error.message}` : `${market}: ${String(error)}`);
      }
    }));

    const next: StockCalendarCache = {
      provider: 'stock-sdk',
      fetchedAt: failures.length ? existing.fetchedAt : now,
      records: Array.from(existingRecords.values()).sort((a, b) => a.market.localeCompare(b.market) || a.year - b.year),
      lastAttemptAt: now,
      lastError: [...failures, ...warnings].join('; ') || undefined,
    };
    await saveCache(next);
    return next;
  }

  async sync(force = false): Promise<StockCalendarCache> {
    await clearLegacyItickSettings();
    const now = this.clock();
    const year = new Date(now).getUTCFullYear();
    const current = await this.ensureYear(year, force);
    return year > 1 ? this.ensureYear(year - 1, force).catch(() => current) : current;
  }

  async status(): Promise<{ configured: boolean; fetchedAt?: number; lastError?: string; recordCount: number }> {
    const cache = await getCache();
    return { configured: true, fetchedAt: cache.fetchedAt || undefined, lastError: cache.lastError, recordCount: cache.records.length };
  }

  async isTradingDay(market: CalendarMarket, date: string): Promise<boolean | undefined> {
    if (market === 'A_SHARE') return undefined;
    const cache = await this.ensureYear(Number(date.slice(0, 4)));
    const record = cache.records.find((candidate) => candidate.market === market && candidate.year === Number(date.slice(0, 4)));
    if (!record || !record.coveredThrough || date > record.coveredThrough) return undefined;
    return isWeekday(date) && !record.closedDates.includes(date);
  }

  async previousExpectedCloseDate(market: CalendarMarket, localToday: string): Promise<string | undefined> {
    let candidate = localToday;
    for (let index = 0; index < 370; index += 1) {
      candidate = addDays(candidate, -1);
      const tradingDay = await this.isTradingDay(market, candidate);
      if (tradingDay === true) return candidate;
      if (tradingDay === undefined && isWeekday(candidate)) return candidate;
    }
    return undefined;
  }
}

export const stockCalendarProvider = new StockCalendarProvider();

export async function syncStockCalendar(force = false): Promise<StockCalendarCache> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = stockCalendarProvider.sync(force);
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = undefined;
  }
}

export async function getStockCalendarStatus(): Promise<{ configured: boolean; fetchedAt?: number; lastError?: string; recordCount: number }> {
  return stockCalendarProvider.status();
}
