import { afterEach, describe, expect, it, vi } from 'vitest';
import { MassiveProvider } from '../core/market/massiveProvider';
import { HistoricalRequestPlanner, INITIAL_CAPABILITIES } from '../core/market/HistoricalRequestPlanner';
import type { MarketProviderConfig, MarketWorkItem } from '../db/schema';

describe('MassiveProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps raw stock aggregates to valid New York trading dates and OHLC bars', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'OK', results: [
      { t: Date.parse('2026-06-01T04:00:00Z'), o: 309.625, h: 310.94, l: 305.02, c: 306.31, v: 100 },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new MassiveProvider().fetchHistoricalBars('AAPL', 'US', 'STOCK', '2026-06-01', '2026-06-01', 'test-key');
    expect(result.ok).toBe(true);
    expect(result.data?.[0]).toMatchObject({ symbol: 'AAPL', market: 'US', assetType: 'STOCK', date: '2026-06-01', adjustmentMode: 'raw', close: 306.31 });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v2/aggs/ticker/AAPL/range/1/day/2026-06-01/2026-06-01?adjusted=false'), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-key' }) }));
  });

  it('maps option aggregates and preserves an unavailable HTTP response for fallback handling', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ t: Date.parse('2026-07-15T04:00:00Z'), o: 2, h: 3, l: 1, c: 2.5, v: 4 }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new MassiveProvider();

    const optionResult = await provider.fetchHistoricalBars('O:AAPL260717C00110000', 'US', 'OPTION', '2026-07-15', '2026-07-15', 'test-key');
    expect(optionResult.data?.[0]).toMatchObject({ assetType: 'OPTION', date: '2026-07-15', provider: 'massive' });

    const forbidden = await provider.fetchHistoricalBars('AAPL', 'US', 'STOCK', '2026-07-15', '2026-07-15', 'test-key');
    expect(forbidden).toMatchObject({ ok: false, httpStatus: 403, status: 'failed' });
  });

  it('plans Massive first for US history but never for realtime quotes or non-US history', () => {
    const config = (provider: MarketProviderConfig['provider'], enabled: number, priority: number, apiKey = ''): MarketProviderConfig => ({ provider, enabled, priority, apiKey, baseUrl: provider, optionsJson: '{}', createdAt: 1, updatedAt: 1 });
    const item = (overrides: Partial<MarketWorkItem>): MarketWorkItem => ({
      id: 'work', kind: 'historical_range_fill', symbol: 'AAPL', securityKey: 'US:AAPL', market: 'US', assetType: 'stock',
      requiredFromDate: '2026-06-01', requiredToDate: '2026-06-05', fetchFromDate: '2026-06-01', fetchToDate: '2026-06-05',
      sourceReason: 'manual', priority: 1, status: 'pending', attemptCount: 0, createdAt: 1, updatedAt: 1, ...overrides,
    });
    const configs = [config('massive', 1, -1, 'test-key'), config('stock-sdk', 1, 0)];
    const historyPlans = HistoricalRequestPlanner.buildRequestPlans({ pendingItems: [item({})], providerConfigs: configs, providerCapabilities: INITIAL_CAPABILITIES, quotaStates: [], now: 1 });
    expect(historyPlans[0].providerId).toBe('massive');
    const quotePlans = HistoricalRequestPlanner.buildRequestPlans({ pendingItems: [item({ id: 'quote', kind: 'realtime_quote_refresh', sourceReason: 'portfolio_page_refresh' })], providerConfigs: configs, providerCapabilities: INITIAL_CAPABILITIES, quotaStates: [], now: 1 });
    expect(quotePlans[0].providerId).toBe('stock-sdk');
    const cnPlans = HistoricalRequestPlanner.buildRequestPlans({ pendingItems: [item({ id: 'cn', symbol: '600519', securityKey: 'A_SHARE:600519', market: 'A_SHARE' })], providerConfigs: configs, providerCapabilities: INITIAL_CAPABILITIES, quotaStates: [], now: 1 });
    expect(cnPlans[0].providerId).toBe('stock-sdk');
  });
});
