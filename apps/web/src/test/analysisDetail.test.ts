import { describe, expect, it } from 'vitest';
import { buildSecurityAnalyses, buildSecurityRangeStats } from '../core/portfolio/analysisDetail';

const rates = { usdToCny: 1, hkdToCny: 1 };
const transaction = (symbol: string, assetType: 'STOCK' | 'OPTION', price: number, date: string, underlyingSymbol: string | null = null) => ({
  ledgerId: 1, tradeType: 'BUY', platform: 'SCHWAB', sourceChannel: null, externalReference: null, market: 'US', symbol, name: underlyingSymbol ? 'AAPL' : symbol, tradeDate: date, tradeTime: '10:00:00', price, quantity: 1, commission: 0, tax: 0, note: '', createdAt: 0, updatedAt: 0, investorName: null, assetType, underlyingSymbol, expiryDate: null, strikePrice: null, optionType: null, fxFromCurrency: null, fxFromAmount: null, fxToCurrency: null, fxToAmount: null, fxRate: null,
}) as any;
const bars = [
  { id: 'US:AAPL:stock:1d:2026-07-01', securityKey: 'US:AAPL', symbol: 'AAPL', market: 'US', assetType: 'stock', resolution: '1d', tradeDate: '2026-07-01', close: 100, providerId: 'test', fetchedAt: 0, dataQuality: 'normal' },
  { id: 'US:AAPL:stock:1d:2026-07-02', securityKey: 'US:AAPL', symbol: 'AAPL', market: 'US', assetType: 'stock', resolution: '1d', tradeDate: '2026-07-02', close: 110, providerId: 'test', fetchedAt: 0, dataQuality: 'normal' },
];

describe('analysis detail utilities', () => {
  it('groups option trades under their underlying and separates stock/derivative profit', () => {
    const analyses = buildSecurityAnalyses({
      transactions: [transaction('AAPL', 'STOCK', 100, '2026-07-01'), transaction('AAPL 260717C00100000', 'OPTION', 2, '2026-07-01', 'AAPL')],
      quotes: [],
      bars: bars as any,
      rates,
    }, '2026-07-02');
    expect(analyses).toHaveLength(1);
    expect(analyses[0].symbol).toBe('AAPL');
    const stats = buildSecurityRangeStats(analyses[0], '2026-07-01', '2026-07-02', 100);
    expect(stats?.stockProfitCny).toBeGreaterThan(0);
    expect(stats?.derivativeProfitCny).toBe(0);
  });

  it('returns no range row when a security has no points in the selected window', () => {
    const analyses = buildSecurityAnalyses({ transactions: [transaction('AAPL', 'STOCK', 100, '2026-07-01')], quotes: [], bars: bars as any, rates }, '2026-07-02');
    expect(buildSecurityRangeStats(analyses[0], '2026-08-01', '2026-08-02', 100)).toBeNull();
  });
});
