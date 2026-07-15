import { StockSDK } from 'stock-sdk';
import { marketFetch } from '../../platform/nativeRuntime';
import { stockCalendarProvider, type CalendarMarket as StockCalendarMarket } from './stockCalendarProvider';

export type CalendarMarket = 'A_SHARE' | 'HK' | 'US';

export interface AShareTradingCalendar {
  isTradingDay(date: string): Promise<boolean>;
  prevTradingDay(date: string): Promise<string>;
}

export interface MarketSpecificTradingCalendar {
  isTradingDay(market: StockCalendarMarket, date: string): Promise<boolean | undefined>;
  previousExpectedCloseDate(market: StockCalendarMarket, date: string): Promise<string | undefined>;
}

function isWeekday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function previousWeekday(date: string): string {
  let candidate = addUtcDays(date, -1);
  while (!isWeekday(candidate)) candidate = addUtcDays(candidate, -1);
  return candidate;
}

function createAShareCalendar(): AShareTradingCalendar {
  const sdk = new StockSDK({ fetchImpl: (input: any, init?: any) => marketFetch(input, init) as any });
  return sdk.calendar;
}

/**
 * stock-sdk supplies an official A-share calendar. iTick supplies the
 * market-specific HK/US holiday data and is cached locally; an unconfigured
 * or unavailable provider falls back to weekday behavior.
 */
export class TradingCalendarService {
  constructor(
    private readonly aShareCalendar: AShareTradingCalendar = createAShareCalendar(),
    private readonly marketCalendar: MarketSpecificTradingCalendar = stockCalendarProvider,
  ) {}

  async isTradingDay(market: string, date: string): Promise<boolean> {
    if (market !== 'A_SHARE') {
      const providerResult = await this.marketCalendar.isTradingDay(market as StockCalendarMarket, date);
      return providerResult ?? isWeekday(date);
    }
    try {
      return await this.aShareCalendar.isTradingDay(date);
    } catch {
      return isWeekday(date);
    }
  }

  /** Last completed session before the local market date, matching existing EOD behavior. */
  async previousExpectedCloseDate(market: string, localToday: string): Promise<string> {
    if (market !== 'A_SHARE') {
      const providerResult = await this.marketCalendar.previousExpectedCloseDate(market as StockCalendarMarket, localToday);
      return providerResult ?? previousWeekday(localToday);
    }
    try {
      return await this.aShareCalendar.prevTradingDay(localToday);
    } catch {
      return previousWeekday(localToday);
    }
  }

  async closedDatesForMarkets(markets: Iterable<string>, dates: Iterable<string>): Promise<Set<string>> {
    const activeMarkets = Array.from(new Set(Array.from(markets).filter((market): market is CalendarMarket => ['A_SHARE', 'HK', 'US'].includes(market))));
    if (!activeMarkets.length) return new Set();
    const closed = new Set<string>();
    for (const date of dates) {
      const openSomewhere = (await Promise.all(activeMarkets.map((market) => this.isTradingDay(market, date)))).some(Boolean);
      if (!openSomewhere) closed.add(date);
    }
    return closed;
  }
}

export const tradingCalendarService = new TradingCalendarService();
