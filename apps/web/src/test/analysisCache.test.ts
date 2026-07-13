import { describe, expect, it, vi } from 'vitest';
import { AnalysisComputationCache } from '../core/portfolio/analysisCache';

const request = { transactions: [], quotes: [], bars: [], rates: { usdToCny: 7.2, hkdToCny: .92 } } as any;
const points = [{ date: '2026-07-01', totalAssetsCny: 0, netInflowCny: 0, dailyProfitCny: 0, cumulativeProfitCny: 0, dailyReturnPercent: 0, cumulativeReturnPercent: 0, dailyCommissionCny: 0, dailyTaxCny: 0, dailyTradeCount: 0 }];

describe('AnalysisComputationCache', () => {
  it('reuses one in-flight and completed result for the same scope/version', async () => {
    const execute = vi.fn(async () => points);
    const cache = new AnalysisComputationCache(execute);

    const [first, second] = await Promise.all([cache.get('ledger:1:ALL:v1', request), cache.get('ledger:1:ALL:v1', request)]);
    const third = await cache.get('ledger:1:ALL:v1', request);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first).toBe(points);
    expect(second).toBe(points);
    expect(third).toBe(points);
  });

  it('recomputes when the data version or scope changes', async () => {
    const execute = vi.fn(async () => points);
    const cache = new AnalysisComputationCache(execute);

    await cache.get('ledger:1:ALL:v1', request);
    await cache.get('ledger:1:ALL:v2', request);
    await cache.get('ledger:2:ALL:v2', request);

    expect(execute).toHaveBeenCalledTimes(3);
  });
});
