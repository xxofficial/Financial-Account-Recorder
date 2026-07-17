import { describe, it, expect } from 'vitest';
import {
  computeMovingAverage,
  filterBarsByRange,
  getCandlestickColors,
  getVolumeColor,
  historicalBarsToChartBars,
  buildTradeMarkers,
} from '../core/chart/chartDataUtils';
import { HistoricalBar, Transaction } from '../db/schema';

function makeBar(overrides: Partial<HistoricalBar> = {}): HistoricalBar {
  return {
    id: 'US:AAPL:stock:1d:2024-01-02',
    securityKey: 'US:AAPL',
    symbol: 'AAPL',
    market: 'US',
    assetType: 'stock',
    resolution: '1d',
    tradeDate: '2024-01-02',
    open: 100,
    high: 105,
    low: 99,
    close: 104,
    volume: 1000,
    providerId: 'test',
    fetchedAt: Date.now(),
    dataQuality: 'normal',
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    ledgerId: 1,
    tradeType: 'BUY',
    platform: 'SCHWAB',
    sourceChannel: null,
    externalReference: null,
    market: 'US',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    tradeDate: '2024-01-02',
    tradeTime: '10:00:00',
    price: 100,
    quantity: 10,
    commission: 0,
    tax: 0,
    note: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    investorName: null,
    assetType: 'STOCK',
    underlyingSymbol: null,
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    fxFromCurrency: null,
    fxFromAmount: null,
    fxToCurrency: null,
    fxToAmount: null,
    fxRate: null,
    ...overrides,
  };
}

describe('chartDataUtils', () => {
  it('should convert historical bars to chart bars', () => {
    const bars = [
      makeBar({ tradeDate: '2024-01-03', open: 100, high: 110, low: 98, close: 105, volume: 2000 }),
      makeBar({ tradeDate: '2024-01-02', open: 100, high: 105, low: 99, close: 104, volume: 1000 }),
    ];
    const chartBars = historicalBarsToChartBars(bars);
    expect(chartBars).toHaveLength(2);
    expect(chartBars[0].time).toBe('2024-01-02');
    expect(chartBars[1].time).toBe('2024-01-03');
    expect(chartBars[1].volume).toBe(2000);
  });

  it('should fill missing open/high/low from close', () => {
    const bar = makeBar({ open: undefined, high: undefined, low: undefined, close: 100 });
    const chartBars = historicalBarsToChartBars([bar]);
    expect(chartBars[0].open).toBe(100);
    expect(chartBars[0].high).toBe(100);
    expect(chartBars[0].low).toBe(100);
  });

  it('should normalize raw prices and volume across a forward split', () => {
    const bars = [
      makeBar({ tradeDate: '2026-06-02', open: 80, high: 88, low: 72, close: 80, volume: 100 }),
      makeBar({ tradeDate: '2026-06-03', open: 10, high: 11, low: 9, close: 10, volume: 800 }),
    ];
    const split = makeTx({ tradeType: 'SPLIT', symbol: 'SNXX', tradeDate: '2026-06-03', price: 8 });
    const chartBars = historicalBarsToChartBars(bars, [split]);
    expect(chartBars[0]).toMatchObject({ open: 10, high: 11, low: 9, close: 10, volume: 800 });
    expect(chartBars[1]).toMatchObject({ open: 10, high: 11, low: 9, close: 10, volume: 800 });
  });

  it('should not normalize bars already marked split-adjusted', () => {
    const bar = makeBar({ tradeDate: '2026-06-02', close: 80, adjustmentMode: 'split_adjusted' });
    const split = makeTx({ tradeType: 'SPLIT', tradeDate: '2026-06-03', price: 8 });
    expect(historicalBarsToChartBars([bar], [split])[0].close).toBe(80);
  });

  it('should filter bars by range', () => {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const bars = [
      { time: lastMonth, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: yesterday, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: today, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const filtered = filterBarsByRange(bars, 'ONE_MONTH');
    expect(filtered.length).toBeGreaterThanOrEqual(2);
    expect(filtered.every((b) => b.time >= lastMonth)).toBe(true);
  });

  it('should compute simple moving average', () => {
    const data = [
      { time: '2024-01-01', value: 10 },
      { time: '2024-01-02', value: 20 },
      { time: '2024-01-03', value: 30 },
      { time: '2024-01-04', value: 40 },
      { time: '2024-01-05', value: 50 },
    ];
    const ma = computeMovingAverage(data, 5);
    expect(ma[0].value).toBeNull();
    expect(ma[1].value).toBeNull();
    expect(ma[2].value).toBeNull();
    expect(ma[3].value).toBeNull();
    expect(ma[4].value).toBe(30);
  });

  it('should return red_up candlestick colors', () => {
    const colors = getCandlestickColors('red_up');
    expect(colors.upColor).toBe('#ef4444');
    expect(colors.downColor).toBe('#10b981');
  });

  it('should return green_up candlestick colors', () => {
    const colors = getCandlestickColors('green_up');
    expect(colors.upColor).toBe('#10b981');
    expect(colors.downColor).toBe('#ef4444');
  });

  it('should return correct volume colors', () => {
    expect(getVolumeColor('red_up', true)).toContain('239, 68, 68');
    expect(getVolumeColor('red_up', false)).toContain('16, 185, 129');
    expect(getVolumeColor('green_up', true)).toContain('16, 185, 129');
    expect(getVolumeColor('green_up', false)).toContain('239, 68, 68');
  });

  it('should build trade markers for BUY and SELL', () => {
    const trades = [
      makeTx({ tradeType: 'BUY', tradeDate: '2024-01-02', quantity: 10 }),
      makeTx({ tradeType: 'SELL', tradeDate: '2024-01-03', quantity: 5 }),
    ];
    const markers = buildTradeMarkers(trades);
    expect(markers).toHaveLength(2);
    expect(markers[0].text).toBe('B');
    expect(markers[0].position).toBe('belowBar');
    expect(markers[1].text).toBe('S');
    expect(markers[1].position).toBe('aboveBar');
  });

  it('should aggregate trades on the same date', () => {
    const trades = [
      makeTx({ tradeType: 'BUY', tradeDate: '2024-01-02', quantity: 10 }),
      makeTx({ tradeType: 'BUY', tradeDate: '2024-01-02', quantity: 5 }),
      makeTx({ tradeType: 'SELL', tradeDate: '2024-01-02', quantity: 3 }),
    ];
    const markers = buildTradeMarkers(trades);
    expect(markers).toHaveLength(2);
    const buy = markers.find((m) => m.text === 'B');
    const sell = markers.find((m) => m.text === 'S');
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    expect(buy?.position).toBe('belowBar');
    expect(sell?.position).toBe('aboveBar');
  });

  it('should exclude option trades from markers', () => {
    const trades = [
      makeTx({ tradeType: 'BUY', assetType: 'OPTION', tradeDate: '2024-01-02', quantity: 1 }),
      makeTx({ tradeType: 'BUY', assetType: 'STOCK', tradeDate: '2024-01-03', quantity: 10 }),
    ];
    const markers = buildTradeMarkers(trades);
    expect(markers).toHaveLength(1);
    expect(markers[0].time).toBe('2024-01-03');
    expect(markers[0].text).toBe('B');
  });

  it('should show a dedicated split marker', () => {
    const markers = buildTradeMarkers([makeTx({ tradeType: 'SPLIT', tradeDate: '2026-06-03', price: 8 })]);
    expect(markers).toEqual([{ time: '2026-06-03', position: 'aboveBar', color: '#6366f1', text: '拆' }]);
  });
});
