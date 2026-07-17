import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/localDb';
import { StockCalendarProvider, STOCK_CALENDAR_CACHE_KEY, type DailyKlineClient } from '../core/market/stockCalendarProvider';

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdays(start: string, end: string): string[] {
  const result: string[] = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    const day = new Date(`${current}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) result.push(current);
  }
  return result;
}

describe('stock-sdk inferred calendar provider', () => {
  afterEach(async () => {
    await db.appSettings.delete(STOCK_CALENDAR_CACHE_KEY);
  });

  it('uses the primary anchor and detects market holidays', async () => {
    const closures = new Set(['2026-07-03', '2026-07-01']);
    const client: DailyKlineClient = {
      dates: vi.fn(async (_market, _symbol, start, end) => weekdays(start, end).filter((date) => !closures.has(date))),
    };
    const provider = new StockCalendarProvider(client, () => Date.parse('2026-07-15T12:00:00Z'));

    const cache = await provider.sync(true);
    expect(cache.provider).toBe('stock-sdk');
    expect(cache.records.find((record) => record.market === 'US' && record.year === 2026)?.closedDates).toContain('2026-07-03');
    expect(cache.records.find((record) => record.market === 'HK' && record.year === 2026)?.closedDates).toContain('2026-07-01');
    expect(client.dates).toHaveBeenCalledTimes(4);
  });

  it('accepts one healthy anchor when the other anchor is unavailable', async () => {
    const client: DailyKlineClient = {
      dates: vi.fn(async (_market, symbol, start, end) => {
        if (symbol === 'SPY' || symbol === '00700') throw new Error('temporary provider failure');
        return weekdays(start, end);
      }),
    };
    const provider = new StockCalendarProvider(client, () => Date.parse('2026-07-15T12:00:00Z'));

    const cache = await provider.sync(true);
    expect(cache.records).toHaveLength(4);
    expect(cache.lastError).toBeUndefined();
    expect(cache.lastWarning).toContain('SPY');
    expect(cache.lastWarning).toContain('00700');
    expect(await provider.isTradingDay('US', '2026-07-14')).toBe(true);
  });

  it('reuses a current-year cache until the next completed date is available', async () => {
    const client: DailyKlineClient = {
      dates: vi.fn(async (_market, _symbol, start, end) => weekdays(start, end)),
    };
    const provider = new StockCalendarProvider(client, () => Date.parse('2026-07-15T12:00:00Z'));

    await provider.sync(false);
    const firstCallCount = vi.mocked(client.dates).mock.calls.length;
    await provider.sync(false);
    expect(vi.mocked(client.dates).mock.calls.length).toBe(firstCallCount);
  });

  it('falls back to the previous weekday when both anchors fail', async () => {
    const provider = new StockCalendarProvider({ dates: vi.fn(async () => { throw new Error('offline'); }) }, () => Date.parse('2026-07-15T12:00:00Z'));
    expect(await provider.previousExpectedCloseDate('US', '2026-07-15')).toBe('2026-07-14');
  });
});
