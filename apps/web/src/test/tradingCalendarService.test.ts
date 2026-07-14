import { describe, expect, it, vi } from 'vitest';
import { TradingCalendarService } from '../core/market/tradingCalendarService';

describe('TradingCalendarService', () => {
  const calendar = {
    isTradingDay: vi.fn(async (date: string) => date === '2026-09-30'),
    prevTradingDay: vi.fn(async () => '2026-09-30'),
  };

  it('uses the stock-sdk calendar for A-share holidays', async () => {
    const service = new TradingCalendarService(calendar);
    expect(await service.isTradingDay('A_SHARE', '2026-10-01')).toBe(false);
    expect(await service.previousExpectedCloseDate('A_SHARE', '2026-10-01')).toBe('2026-09-30');
    expect(calendar.isTradingDay).toHaveBeenCalledWith('2026-10-01');
    expect(calendar.prevTradingDay).toHaveBeenCalledWith('2026-10-01');
  });

  it('keeps HK/US on an explicit weekday fallback', async () => {
    const service = new TradingCalendarService(calendar);
    expect(await service.isTradingDay('US', '2026-07-11')).toBe(false);
    expect(await service.previousExpectedCloseDate('HK', '2026-07-13')).toBe('2026-07-10');
  });

  it('marks a date closed only when every active market is closed', async () => {
    const service = new TradingCalendarService(calendar);
    const closed = await service.closedDatesForMarkets(['A_SHARE'], ['2026-09-30', '2026-10-01']);
    expect(Array.from(closed)).toEqual(['2026-10-01']);
  });
});
