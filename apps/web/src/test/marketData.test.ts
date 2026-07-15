import { describe, expect, it, vi } from 'vitest';
import { AndroidDefaultMarketProvider } from '../core/market/androidDefaultMarketProvider';
import { HistoricalRequestPlanner, INITIAL_CAPABILITIES } from '../core/market/HistoricalRequestPlanner';
import { MarketDataAppProvider, marketDataExclusiveEndDate } from '../core/market/marketDataProvider';
import { StockSdkProvider } from '../core/market/stockSdkProvider';

describe('stock-sdk stock routing', () => {
  it('only accepts A/HK/US stocks', () => {
    const provider = new StockSdkProvider();
    expect(provider.supportsAssetType('STOCK')).toBe(true);
    expect(provider.supportsAssetType('OPTION')).toBe(false);
    expect(['A_SHARE', 'HK', 'US'].every(market => provider.supportsMarket(market))).toBe(true);
  });

  it('rejects empty, out-of-range and invalid OHLC bars before cache writes', () => {
    const provider = new StockSdkProvider() as any;
    expect(provider.toBar({}, '600519', 'A_SHARE', '2026-07-01', '2026-07-02')).toBeNull();
    expect(provider.toBar({ date: '2026-06-30', open: 1, high: 1, low: 1, close: 1 }, '600519', 'A_SHARE', '2026-07-01', '2026-07-02')).toBeNull();
    expect(provider.toBar({ date: '2026-07-01', open: 10, high: 9, low: 8, close: 10 }, '600519', 'A_SHARE', '2026-07-01', '2026-07-02')).toBeNull();
    expect(provider.toBar({ date: '2026-07-01', open: 10, high: 12, low: 9, close: 11, volume: 1 }, '600519', 'A_SHARE', '2026-07-01', '2026-07-02')).toMatchObject({ adjustmentMode: 'raw', close: 11 });
  });

  it('passes compact startDate and endDate to the stock-sdk history endpoint', async () => {
    const provider = new StockSdkProvider() as any;
    const us = vi.fn().mockResolvedValue([]);
    provider.sdk = () => ({ kline: { us } });
    provider.started = vi.fn().mockResolvedValue(undefined);
    provider.failed = vi.fn().mockReturnValue({ ok: false, status: 'empty_data', provider: 'stock-sdk' });

    await provider.fetchHistoricalBars('AMD', 'US', 'STOCK', '2026-01-02', '2026-07-15', '');

    expect(us).toHaveBeenCalledWith(expect.any(String), {
      period: 'daily',
      startDate: '20260102',
      endDate: '20260715',
      adjust: '',
    });
  });

  it('plans keyless stock-sdk work without allowing option work', () => {
    const plans = HistoricalRequestPlanner.buildRequestPlans({
      pendingItems: [{ id: 'stock', kind: 'historical_range_fill', securityKey: 'US:AAPL', symbol: 'AAPL', market: 'US', assetType: 'stock', resolution: '1d', requiredFromDate: '2026-07-01', requiredToDate: '2026-07-02', fetchFromDate: '2026-07-01', fetchToDate: '2026-07-02', sourceReason: 'manual', priority: 1, status: 'pending', attemptCount: 0, createdAt: 1, updatedAt: 1 }],
      providerConfigs: [{ provider: 'stock-sdk', enabled: 1, priority: 0, apiKey: '', baseUrl: 'stock-sdk', optionsJson: '{}', createdAt: 1, updatedAt: 1 }],
      providerCapabilities: INITIAL_CAPABILITIES, quotaStates: [], now: 2,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ providerId: 'stock-sdk', strategy: 'symbol_range' });
  });

  it('keeps option providers isolated from stock routes', () => {
    const marketdata = new MarketDataAppProvider();
    const android = new AndroidDefaultMarketProvider();
    expect(marketdata.supportsAssetType('STOCK')).toBe(false);
    expect(marketdata.supportsAssetType('OPTION')).toBe(true);
    expect(android.supportsAssetType('STOCK')).toBe(false);
    expect(android.supportsMarket('HK')).toBe(false);
    expect(android.supportsAssetType('OPTION')).toBe(true);
  });

  it('keeps the requested option end date when MarketData requires an exclusive boundary', () => {
    expect(marketDataExclusiveEndDate('2026-07-08')).toBe('2026-07-09');
    expect(marketDataExclusiveEndDate('2026-12-31')).toBe('2027-01-01');
  });
});
