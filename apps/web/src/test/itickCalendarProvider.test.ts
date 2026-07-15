import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/localDb';
import { ITICK_CALENDAR_CACHE_KEY, ITICK_CALENDAR_TOKEN_KEY, parseItickHolidayResponse, syncItickCalendar } from '../core/market/itickCalendarProvider';

describe('iTick calendar provider', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.appSettings.bulkDelete([ITICK_CALENDAR_TOKEN_KEY, ITICK_CALENDAR_CACHE_KEY]);
  });

  it('normalizes iTick market codes and annual holiday payloads', () => {
    const records = parseItickHolidayResponse({
      data: [
        { c: 'HK', ey: 2026, et: '09:30 - 16:00', v: '["2026-02-17","2026-04-03"]' },
        { c: 'US', ey: '2026', v: ['2026-01-01', 'invalid'] },
        { c: 'UNKNOWN', ey: 2026, v: '["2026-01-01"]' },
      ],
    });

    expect(records).toEqual([
      { market: 'HK', year: 2026, closedDates: ['2026-02-17', '2026-04-03'], tradingHours: '09:30 - 16:00' },
      { market: 'US', year: 2026, closedDates: ['2026-01-01'], tradingHours: undefined },
    ]);
  });

  it('syncs once and reuses the local cache within the refresh window', async () => {
    await db.appSettings.put({ key: ITICK_CALENDAR_TOKEN_KEY, value: 'test-token', updatedAt: Date.now() });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ c: 'US', ey: 2026, v: '["2026-07-03"]' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const [first, concurrent] = await Promise.all([syncItickCalendar(true), syncItickCalendar(true)]);
    const second = await syncItickCalendar();

    expect(first?.records).toEqual([{ market: 'US', year: 2026, closedDates: ['2026-07-03'], tradingHours: undefined }]);
    expect(concurrent?.fetchedAt).toBe(first?.fetchedAt);
    expect(second?.fetchedAt).toBe(first?.fetchedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
