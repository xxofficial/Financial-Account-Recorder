import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/localDb';
import { MarketDataCacheService, rankSecuritySuggestions } from '../core/market/marketDataCacheService';

const transaction = (overrides: Record<string, unknown> = {}) => ({
  ledgerId: 1, tradeType: 'BUY', platform: 'SCHWAB', market: 'US', symbol: 'AAPL', name: 'Apple Inc.',
  tradeDate: '2026-07-01', tradeTime: '10:00:00', price: 1, quantity: 1, commission: 0, tax: 0, note: '',
  createdAt: 1, updatedAt: 1, investorName: null, assetType: 'STOCK', underlyingSymbol: null, expiryDate: null,
  strikePrice: null, optionType: null, fxFromCurrency: null, fxFromAmount: null, fxToCurrency: null,
  fxToAmount: null, fxRate: null, sourceChannel: null, externalReference: null, ...overrides,
});

describe('security suggestions', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.quoteSnapshots.clear();
  });

  it('deduplicates and ranks exact code, code prefix, then name matches', () => {
    const result = rankSecuritySuggestions('aapl', [
      { symbol: 'AAPLQ', market: 'US', name: 'Apple Extra', assetType: 'STOCK' },
      { symbol: 'AAPL', market: 'US', name: 'Apple Inc.', assetType: 'STOCK' },
      { symbol: 'AAPL', market: 'US', name: 'Duplicate', assetType: 'STOCK' },
      { symbol: 'MSFT', market: 'US', name: 'AAPL supplier', assetType: 'STOCK' },
    ]);
    expect(result.map((item) => item.symbol)).toEqual(['AAPL', 'AAPLQ', 'MSFT']);
    expect(result[0].name).toBe('Apple Inc.');
  });

  it('merges remote candidates with local transactions and quotes without cache writes', async () => {
    await db.transactions.add(transaction() as any);
    await db.quoteSnapshots.add({ id: 'US:APPN', symbol: 'APPN', market: 'US', name: 'Appian', assetType: 'STOCK', currentPrice: null, previousClose: null, change: null, changePercent: null, currency: 'USD', provider: 'test', fetchedAt: 1 });
    const service = new MarketDataCacheService() as any;
    service.getActiveProviders = async () => [{
      apiKey: '',
      provider: {
        name: 'test', supportsAssetType: () => true, supportsMarket: () => true,
        suggestSecurities: async () => ({ ok: true, status: 'success', provider: 'test', data: [
          { symbol: 'AAPL', market: 'US', name: 'Remote duplicate', assetType: 'STOCK' },
          { symbol: 'APPF', market: 'US', name: 'AppFolio', assetType: 'STOCK' },
        ] }),
      },
    }];

    const result = await service.suggestSecurities('app', 'US');
    expect(result.map((item: { symbol: string }) => item.symbol)).toEqual(['APPF', 'APPN', 'AAPL']);
    expect((await db.quoteSnapshots.get('US:AAPL'))).toBeUndefined();
  });

  it('keeps local candidates when a configured provider fails and excludes options', async () => {
    await db.transactions.bulkAdd([
      transaction({ symbol: 'AAPL', name: 'Apple Inc.' }),
      transaction({ symbol: 'AAPL260821C00200000', name: 'Apple option', assetType: 'OPTION' }),
    ] as any);
    const service = new MarketDataCacheService() as any;
    service.getActiveProviders = async () => [{
      apiKey: '', provider: { name: 'failing', supportsAssetType: () => true, supportsMarket: () => true, suggestSecurities: async () => { throw new Error('offline'); } },
    }];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(service.suggestSecurities('aap', 'US')).resolves.toEqual([
      expect.objectContaining({ symbol: 'AAPL', name: 'Apple Inc.', assetType: 'STOCK' }),
    ]);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });
});
