import { describe, expect, it } from 'vitest';
import { AnalysisPoint, buildAnalysisPoints, buildAnalysisStats, formatSignedDisplayAmount, resolveAnalysisRange } from '../core/portfolio/analysisUtils';

const points: AnalysisPoint[] = [
  { date: '2026-07-01', totalAssetsCny: 100, netInflowCny: 100, dailyProfitCny: 0, cumulativeProfitCny: 0, dailyReturnPercent: 0, cumulativeReturnPercent: 0, dailyCommissionCny: 0, dailyTaxCny: 0, dailyTradeCount: 1 },
  { date: '2026-07-02', totalAssetsCny: 110, netInflowCny: 100, dailyProfitCny: 10, cumulativeProfitCny: 10, dailyReturnPercent: 10, cumulativeReturnPercent: 10, dailyCommissionCny: 2, dailyTaxCny: 1, dailyTradeCount: 2 },
  { date: '2026-07-03', totalAssetsCny: 105, netInflowCny: 100, dailyProfitCny: -5, cumulativeProfitCny: 5, dailyReturnPercent: -4.545, cumulativeReturnPercent: 5, dailyCommissionCny: 0, dailyTaxCny: 0, dailyTradeCount: 0 },
];

describe('analysis utilities', () => {
  it('converts CNY-backed amounts when formatting the selected display currency', () => {
    expect(formatSignedDisplayAmount(720, '$', 7.2)).toBe('+$100.00');
    expect(formatSignedDisplayAmount(-92, 'HK$', 0.92)).toBe('-HK$100.00');
  });

  it('clamps custom date ranges to available analysis data', () => {
    expect(resolveAnalysisRange('CUSTOM', '2026-07-01', '2026-07-03', '2026-06-01', '2026-08-01')).toEqual(['2026-07-01', '2026-07-03']);
    expect(resolveAnalysisRange('CUSTOM', '2026-07-01', '2026-07-03', '2026-07-03', '2026-07-01')).toEqual(['2026-07-03', '2026-07-03']);
  });

  it('builds range statistics for wins, total profit and drawdown', () => {
    const stats = buildAnalysisStats(points);
    expect(stats.totalProfitCny).toBe(5);
    expect(stats.averageDailyProfitCny).toBeCloseTo(5 / 3);
    expect(stats.winRate).toBeCloseTo(100 / 3);
    expect(stats.bestDayProfitCny).toBe(10);
    expect(stats.maxDrawdownPercent).toBeLessThan(0);
  });

  it('resolves the Android month and year range labels', () => {
    expect(resolveAnalysisRange('THIS_MONTH', '2026-01-01', '2026-07-12')).toEqual(['2026-07-01', '2026-07-12']);
    expect(resolveAnalysisRange('THIS_YEAR', '2025-01-01', '2026-07-12')).toEqual(['2026-01-01', '2026-07-12']);
  });

  it('builds analysis data from the canonical historicalBars cache', () => {
    const transaction = { ledgerId: 1, tradeType: 'BUY', platform: 'SCHWAB', sourceChannel: null, externalReference: null, market: 'US', symbol: 'AAPL', name: 'Apple', tradeDate: '2026-07-01', tradeTime: '10:00:00', price: 100, quantity: 1, commission: 0, tax: 0, note: '', createdAt: 0, updatedAt: 0, investorName: null, assetType: 'STOCK', underlyingSymbol: null, expiryDate: null, strikePrice: null, optionType: null, fxFromCurrency: null, fxFromAmount: null, fxToCurrency: null, fxToAmount: null, fxRate: null } as any;
    const bars = [
      { id: 'US:AAPL:stock:1d:2026-07-01', securityKey: 'US:AAPL', symbol: 'AAPL', market: 'US', assetType: 'stock', resolution: '1d', tradeDate: '2026-07-01', close: 100, providerId: 'test', fetchedAt: 0, dataQuality: 'normal' },
      { id: 'US:AAPL:stock:1d:2026-07-02', securityKey: 'US:AAPL', symbol: 'AAPL', market: 'US', assetType: 'stock', resolution: '1d', tradeDate: '2026-07-02', close: 110, providerId: 'test', fetchedAt: 0, dataQuality: 'normal' },
    ] as any;

    const result = buildAnalysisPoints([transaction], [], bars, { usdToCny: 1, hkdToCny: 1 }, '2026-07-02');

    expect(result).toHaveLength(2);
    expect(result[1].totalAssetsCny).toBe(10);
    expect(result[1].dailyProfitCny).toBe(10);
  });
});
