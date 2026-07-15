import { db } from '../../db/localDb';
import { marketFetch } from '../../platform/nativeRuntime';

export type CalendarMarket = 'A_SHARE' | 'HK' | 'US';

export interface ItickCalendarRecord {
  market: CalendarMarket;
  year: number;
  closedDates: string[];
  tradingHours?: string;
}

export interface ItickCalendarCache {
  provider: 'itick';
  fetchedAt: number;
  records: ItickCalendarRecord[];
  lastError?: string;
  lastAttemptAt?: number;
}

export interface ItickHolidayResponse {
  data?: Array<{
    c?: string;
    ey?: string | number;
    et?: string;
    v?: string | string[];
  }>;
}

export const ITICK_CALENDAR_TOKEN_KEY = 'itick_calendar_api_token';
export const ITICK_CALENDAR_CACHE_KEY = 'itick_calendar_cache_v1';
const ITICK_CALENDAR_URL = 'https://api.itick.org/symbol/holidays';
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
let syncInFlight: Promise<ItickCalendarCache | undefined> | undefined;

function marketForCode(code: string | undefined): CalendarMarket | undefined {
  const normalized = code?.trim().toUpperCase();
  if (normalized === 'CN' || normalized === 'A' || normalized === 'A_SHARE') return 'A_SHARE';
  if (normalized === 'HK' || normalized === 'HKG' || normalized === 'XHKG') return 'HK';
  if (normalized === 'US' || normalized === 'USA' || normalized === 'XNYS') return 'US';
  return undefined;
}

function parseDates(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : (() => {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  return Array.from(new Set(values.filter((date): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)))).sort();
}

export function parseItickHolidayResponse(payload: ItickHolidayResponse): ItickCalendarRecord[] {
  const merged = new Map<string, ItickCalendarRecord>();
  for (const item of payload.data ?? []) {
    const market = marketForCode(item.c);
    if (!market) continue;
    const closedDates = parseDates(item.v);
    const years = new Set(closedDates.map((date) => Number(date.slice(0, 4))));
    const declaredYear = Number(item.ey);
    if (Number.isInteger(declaredYear) && declaredYear > 1900) years.add(declaredYear);
    for (const year of years) {
      const key = `${market}:${year}`;
      const current = merged.get(key);
      const datesForYear = closedDates.filter((date) => date.startsWith(`${year}-`));
      merged.set(key, {
        market,
        year,
        closedDates: Array.from(new Set([...(current?.closedDates ?? []), ...datesForYear])).sort(),
        tradingHours: item.et ?? current?.tradingHours,
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.market.localeCompare(b.market) || a.year - b.year);
}

function isWeekday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function readCache(value: unknown): ItickCalendarCache | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ItickCalendarCache>;
  if (candidate.provider !== 'itick' || !Array.isArray(candidate.records)) return undefined;
  return {
    provider: 'itick',
    fetchedAt: Number(candidate.fetchedAt) || 0,
    records: candidate.records.filter((record): record is ItickCalendarRecord => Boolean(record && typeof record === 'object' && ['A_SHARE', 'HK', 'US'].includes((record as ItickCalendarRecord).market) && Number.isInteger((record as ItickCalendarRecord).year) && Array.isArray((record as ItickCalendarRecord).closedDates))),
    lastError: typeof candidate.lastError === 'string' ? candidate.lastError : undefined,
    lastAttemptAt: Number(candidate.lastAttemptAt) || undefined,
  };
}

async function getToken(): Promise<string> {
  const setting = await db.appSettings.get(ITICK_CALENDAR_TOKEN_KEY);
  return typeof setting?.value === 'string' ? setting.value.trim() : '';
}

async function getCache(): Promise<ItickCalendarCache | undefined> {
  const setting = await db.appSettings.get(ITICK_CALENDAR_CACHE_KEY);
  return readCache(setting?.value);
}

async function saveCache(cache: ItickCalendarCache): Promise<void> {
  await db.appSettings.put({ key: ITICK_CALENDAR_CACHE_KEY, value: cache, updatedAt: Date.now() });
}

export async function getItickCalendarStatus(): Promise<{ configured: boolean; fetchedAt?: number; lastError?: string; recordCount: number }> {
  const [token, cache] = await Promise.all([getToken(), getCache()]);
  return { configured: Boolean(token), fetchedAt: cache?.fetchedAt, lastError: cache?.lastError, recordCount: cache?.records.length ?? 0 };
}

function cacheCoversCurrentYear(cache: ItickCalendarCache | undefined, now: number): boolean {
  if (!cache?.fetchedAt) return false;
  const currentYear = new Date(now).getUTCFullYear();
  const fetchedYear = new Date(cache.fetchedAt).getUTCFullYear();
  return fetchedYear === currentYear && cache.records.some((record) => record.year === currentYear);
}

async function syncItickCalendarInternal(force: boolean): Promise<ItickCalendarCache | undefined> {
  const token = await getToken();
  if (!token) return getCache();
  const existing = await getCache();
  const now = Date.now();
  // Holiday calendars are annual data. Keep a successfully fetched current-year
  // calendar until the year changes; manual refresh remains available in settings.
  if (!force && cacheCoversCurrentYear(existing, now)) return existing;
  if (!force && existing?.lastAttemptAt && now - existing.lastAttemptAt < RETRY_INTERVAL_MS) return existing;

  const attempt: ItickCalendarCache = { provider: 'itick', fetchedAt: existing?.fetchedAt ?? 0, records: existing?.records ?? [], lastAttemptAt: now };
  try {
    const response = await marketFetch(ITICK_CALENDAR_URL, { headers: { accept: 'application/json', token } });
    if (!response.ok) throw new Error(`iTick HTTP ${response.status}`);
    const records = parseItickHolidayResponse(await response.json() as ItickHolidayResponse);
    if (!records.length) throw new Error('iTick calendar response is empty');
    const byKey = new Map((existing?.records ?? []).map((record) => [`${record.market}:${record.year}`, record]));
    for (const record of records) byKey.set(`${record.market}:${record.year}`, record);
    const next: ItickCalendarCache = { provider: 'itick', fetchedAt: now, records: Array.from(byKey.values()), lastAttemptAt: now };
    await saveCache(next);
    return next;
  } catch (error) {
    const next = { ...attempt, lastError: error instanceof Error ? error.message : 'iTick 日历同步失败' };
    await saveCache(next);
    return next;
  }
}

export async function syncItickCalendar(force = false): Promise<ItickCalendarCache | undefined> {
  // Calendar checks can be issued by several pages during startup. Share one
  // request so they cannot fan out into duplicate iTick calls.
  if (syncInFlight) return syncInFlight;
  syncInFlight = syncItickCalendarInternal(force);
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = undefined;
  }
}

export class ItickCalendarProvider {
  async isTradingDay(market: CalendarMarket, date: string): Promise<boolean | undefined> {
    const cache = await syncItickCalendar();
    const record = cache?.records.find((candidate) => candidate.market === market && candidate.year === Number(date.slice(0, 4)));
    if (!record) return undefined;
    return isWeekday(date) && !record.closedDates.includes(date);
  }

  async previousExpectedCloseDate(market: CalendarMarket, localToday: string): Promise<string | undefined> {
    let candidate = localToday;
    for (let index = 0; index < 370; index += 1) {
      const date = new Date(`${candidate}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - 1);
      candidate = date.toISOString().slice(0, 10);
      const isTradingDay = await this.isTradingDay(market, candidate);
      if (isTradingDay === true) return candidate;
      if (isTradingDay === undefined && isWeekday(candidate)) return candidate;
    }
    return undefined;
  }
}

export const itickCalendarProvider = new ItickCalendarProvider();
