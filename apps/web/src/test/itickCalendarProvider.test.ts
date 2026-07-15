import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/localDb';
import { ITICK_CALENDAR_CACHE_KEY, ITICK_CALENDAR_TOKEN_KEY, normalizeItickToken, parseItickHolidayResponse, syncItickCalendar } from '../core/market/itickCalendarProvider';

describe('iTick calendar provider', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.appSettings.bulkDelete([ITICK_CALENDAR_TOKEN_KEY, ITICK_CALENDAR_CACHE_KEY]);
  });

  it('normalizes iTick market codes and annual holiday payloads', () => {
    const records = parseItickHolidayResponse({
      data: [
        { c: 'HK', d: '2026-02-17', t: '09:30 - 16:00' },
        { c: 'HK', d: '2026-04-03', t: '09:30 - 16:00' },
        { c: 'US', d: '2026-01-01' },
        { c: 'UNKNOWN', d: '2026-01-01' },
      ],
    });

    expect(records).toEqual([
      { market: 'HK', year: 2026, closedDates: ['2026-02-17', '2026-04-03'], tradingHours: '09:30 - 16:00' },
      { market: 'US', year: 2026, closedDates: ['2026-01-01'], tradingHours: undefined },
    ]);
  });

  it('normalizes copied Bearer and quoted token values', () => {
    expect(normalizeItickToken('  Bearer "abc123"  ')).toBe('abc123');
    expect(normalizeItickToken("'abc123'")).toBe('abc123');
    expect(normalizeItickToken('token: abc123')).toBe('abc123');
  });

  it('syncs once and reuses the local cache within the refresh window', async () => {
    await db.appSettings.put({ key: ITICK_CALENDAR_TOKEN_KEY, value: 'Bearer "test-token"', updatedAt: Date.now() });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      const code = new URL(url).searchParams.get('code');
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: [{ c: code, d: code === 'HK' ? '2026-07-01' : '2026-07-03', t: '09:30-16:00' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [first, concurrent] = await Promise.all([syncItickCalendar(true), syncItickCalendar(true)]);
    const second = await syncItickCalendar();

    expect(first?.records).toEqual([
      { market: 'HK', year: 2026, closedDates: ['2026-07-01'], tradingHours: '09:30-16:00' },
      { market: 'US', year: 2026, closedDates: ['2026-07-03'], tradingHours: '09:30-16:00' },
    ]);
    expect(concurrent?.fetchedAt).toBe(first?.fetchedAt);
    expect(second?.fetchedAt).toBe(first?.fetchedAt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual([
      'https://api.itick.org/symbol/v2/holidays?code=HK',
      'https://api.itick.org/symbol/v2/holidays?code=US',
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get('token') === 'test-token')).toBe(true);
  });

  it('reports business errors and does not mark a partial calendar as complete', async () => {
    await db.appSettings.put({ key: ITICK_CALENDAR_TOKEN_KEY, value: 'test-token', updatedAt: Date.now() });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify({ code: String(input).endsWith('code=HK') ? 1001 : 0, msg: 'invalid token', data: [] }), { status: 200 })));

    const result = await syncItickCalendar(true);
    expect(result?.fetchedAt).toBe(0);
    expect(result?.records).toEqual([]);
    expect(result?.lastError).toContain('iTick HK');
  });
});
