import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/localDb';
import { marketCacheManager, marketTodayForHistoricalSync } from '../core/market/marketCacheManager';
import { HistoricalBar } from '../db/schema';

function createTestBar(
  symbol: string,
  market: string,
  tradeDate: string,
  overrides: Partial<HistoricalBar> = {}
): HistoricalBar {
  const assetType = overrides.assetType || 'stock';
  return {
    id: `${market}:${symbol}:${assetType}:1d:${tradeDate}`,
    securityKey: `${market}:${symbol}`,
    symbol,
    market,
    assetType: assetType as any,
    resolution: '1d',
    tradeDate,
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

function createCacheFile(bars: any[], coverage?: any[]): File {
  const data = {
    version: 'market-cache-v1',
    generatedAt: new Date().toISOString(),
    generator: { name: 'test', version: '1.0.0' },
    bars,
    coverage: coverage ?? [],
  };
  return new File([JSON.stringify(data)], 'market-cache-v1-test.json', { type: 'application/json' });
}

describe('MarketCacheManager', () => {
  beforeEach(async () => {
    await db.historicalBars.clear();
    await db.historicalCoverage.clear();
    await db.marketWorkItems.clear();
    await db.transactions.clear();
  });

  it('should export empty cache', async () => {
    const cache = await marketCacheManager.exportMarketCache();
    expect(cache.version).toBe('market-cache-v1');
    expect(cache.bars).toHaveLength(0);
    expect(cache.coverage).toHaveLength(0);
  });

  it('should export bars and coverage', async () => {
    await db.historicalBars.bulkAdd([
      createTestBar('AAPL', 'US', '2024-01-02', { close: 185, high: 188, low: 184 }),
      createTestBar('AAPL', 'US', '2024-01-03', { close: 187, high: 189, low: 186 }),
    ]);
    await db.historicalCoverage.add({
      securityKey: 'US:AAPL',
      resolution: '1d',
      fromDate: '2024-01-02',
      toDate: '2024-01-03',
      providerId: 'test',
      coverageStatus: 'complete',
      updatedAt: Date.now(),
    });

    const cache = await marketCacheManager.exportMarketCache();
    expect(cache.bars).toHaveLength(2);
    expect(cache.coverage).toHaveLength(1);
    expect(cache.bars[0].symbol).toBe('AAPL');
  });

  it('should reject invalid bars during import', async () => {
    const file = createCacheFile([
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-02',
        close: 0, // invalid
        high: 188,
        low: 184,
        open: 185,
      },
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-03',
        close: 187,
        high: 184, // high < low
        low: 186,
        open: 185,
      },
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-04',
        close: 187,
        high: 189,
        low: 186,
        open: 188,
      },
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: 'invalid-date', // invalid
        close: 187,
        high: 189,
        low: 186,
        open: 185,
      },
    ]);

    const report = await marketCacheManager.importMarketCache(file);
    expect(report.valid).toBe(1);
    expect(report.invalid).toBe(3);
    expect(report.invalidDetails.some((d) => d.reason.includes('close'))).toBe(true);
    expect(report.invalidDetails.some((d) => d.reason.includes('high'))).toBe(true);
    expect(report.invalidDetails.some((d) => d.reason.includes('tradeDate'))).toBe(true);
  });

  it('should only fill missing bars in default mode', async () => {
    await db.historicalBars.add(createTestBar('AAPL', 'US', '2024-01-02', { close: 185, high: 188, low: 184 }));

    const file = createCacheFile([
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-02',
        close: 999,
        high: 1000,
        low: 900,
        open: 950,
      },
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-03',
        close: 187,
        high: 189,
        low: 186,
        open: 188,
      },
    ]);

    const report = await marketCacheManager.importMarketCache(file);
    expect(report.inserted).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.overwritten).toBe(0);

    const bar = await db.historicalBars.get('US:AAPL:stock:1d:2024-01-02');
    expect(bar?.close).toBe(185); // unchanged
    const newBar = await db.historicalBars.get('US:AAPL:stock:1d:2024-01-03');
    expect(newBar?.close).toBe(187);
  });

  it('should overwrite existing bars in overwrite mode and report old source', async () => {
    await db.historicalBars.add(
      createTestBar('AAPL', 'US', '2024-01-02', {
        close: 185,
        high: 188,
        low: 184,
        providerId: 'old-provider',
        sourceName: 'Old Source',
        fetchedAt: 1700000000000,
      })
    );

    const file = createCacheFile([
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-02',
        close: 999,
        high: 1000,
        low: 900,
        open: 950,
        sourceName: 'New Source',
      },
    ]);

    const report = await marketCacheManager.importMarketCache(file, { overwrite: true });
    expect(report.overwritten).toBe(1);
    expect(report.overwrittenDetails).toHaveLength(1);
    expect(report.overwrittenDetails[0].oldProviderId).toBe('old-provider');
    expect(report.overwrittenDetails[0].oldSourceName).toBe('Old Source');

    const bar = await db.historicalBars.get('US:AAPL:stock:1d:2024-01-02');
    expect(bar?.close).toBe(999);
    expect(bar?.sourceName).toBe('New Source');
  });

  it('should rebuild historicalCoverage after import', async () => {
    const file = createCacheFile([
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-02',
        close: 185,
        high: 188,
        low: 184,
        open: 186,
      },
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-03',
        close: 187,
        high: 189,
        low: 186,
        open: 188,
      },
    ]);

    await marketCacheManager.importMarketCache(file);
    const coverage = await db.historicalCoverage.toArray();
    expect(coverage).toHaveLength(1);
    expect(coverage[0].securityKey).toBe('US:AAPL');
    expect(coverage[0].fromDate).toBe('2024-01-02');
    expect(coverage[0].toDate).toBe('2024-01-03');
    expect(coverage[0].coverageStatus).toBe('complete');
  });

  it('should reconcile work items after import', async () => {
    await db.marketWorkItems.bulkAdd([
      {
        id: 'hist_fill_US_AAPL_2024-01-01_2024-01-02',
        kind: 'historical_range_fill',
        securityKey: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        requiredFromDate: '2024-01-01',
        requiredToDate: '2024-01-02',
        fetchFromDate: '2024-01-01',
        fetchToDate: '2024-01-02',
        sourceReason: 'manual',
        priority: 850,
        status: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'daily_update_US_AAPL_2024-01-02',
        kind: 'daily_close_update',
        securityKey: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-02',
        sourceReason: 'daily_close_update',
        priority: 700,
        status: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'hist_fill_US_AAPL_2024-01-05_2024-01-10',
        kind: 'historical_range_fill',
        securityKey: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        requiredFromDate: '2024-01-05',
        requiredToDate: '2024-01-10',
        fetchFromDate: '2024-01-05',
        fetchToDate: '2024-01-10',
        sourceReason: 'manual',
        priority: 850,
        status: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const file = createCacheFile([
      {
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-02',
        close: 185,
        high: 188,
        low: 184,
        open: 186,
      },
    ]);

    await marketCacheManager.importMarketCache(file);

    const items = await db.marketWorkItems.toArray();
    const first = items.find((i) => i.id === 'hist_fill_US_AAPL_2024-01-01_2024-01-02');
    const daily = items.find((i) => i.id === 'daily_update_US_AAPL_2024-01-02');
    const partial = items.find((i) => i.id === 'hist_fill_US_AAPL_2024-01-05_2024-01-10');

    expect(first?.status).toBe('pending');
    expect(first?.requiredFromDate).toBe('2024-01-01');
    expect(first?.requiredToDate).toBe('2024-01-02');
    expect(daily?.status).toBe('success');
    expect(partial?.status).toBe('pending');
  });

  it('should detect missing ranges and queue a single work item per security', async () => {
    await db.transactions.bulkAdd([
      {
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
        price: 180,
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
      },
      {
        ledgerId: 1,
        tradeType: 'SELL',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        tradeDate: '2024-01-10',
        tradeTime: '10:00:00',
        price: 190,
        quantity: 5,
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
      },
    ]);

    const summary = await marketCacheManager.detectAndQueueMissingRanges(new Date('2026-07-12T12:00:00Z'));
    expect(summary.queued).toBe(1);
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0].securityKey).toBe('US:AAPL');
    expect(summary.items[0].fromDate).toBe('2024-01-02');
    expect(summary.items[0].toDate).toBe('2026-07-12');

    const items = await db.marketWorkItems.where('kind').equals('historical_range_fill').toArray();
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('pending');
    expect(items[0].requiredFromDate).toBe('2024-01-02');
    expect(items[0].requiredToDate).toBe('2026-07-12');
  });

  it('does not queue an already provider-confirmed history range again on app open', async () => {
    await db.transactions.add({ ledgerId: 1, tradeType: 'BUY', platform: 'SCHWAB', market: 'US', symbol: 'AAPL', name: 'Apple Inc.', tradeDate: '2026-07-01', tradeTime: '10:00:00', price: 180, quantity: 1, commission: 0, tax: 0, note: '', createdAt: Date.now(), updatedAt: Date.now(), investorName: null, assetType: 'STOCK', underlyingSymbol: null, expiryDate: null, strikePrice: null, optionType: null, fxFromCurrency: null, fxFromAmount: null, fxToCurrency: null, fxToAmount: null, fxRate: null, sourceChannel: null, externalReference: null } as any);
    await db.historicalCoverage.add({ securityKey: 'US:AAPL', resolution: '1d', fromDate: '2026-07-01', toDate: '2026-07-12', providerId: 'test', coverageStatus: 'complete', updatedAt: Date.now() });

    const summary = await marketCacheManager.detectAndQueueMissingRanges(new Date('2026-07-12T12:00:00Z'));

    expect(summary.queued).toBe(0);
    expect(await db.marketWorkItems.where('kind').equals('historical_range_fill').count()).toBe(0);
  });

  it('extends HK history through the market-local current date after the last transaction', async () => {
    await db.transactions.bulkAdd([
      { ledgerId: 1, tradeType: 'BUY', platform: 'MANUAL', market: 'HK', symbol: '7709', name: '7709', tradeDate: '2026-06-01', tradeTime: '10:00:00', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: Date.now(), updatedAt: Date.now(), assetType: 'STOCK' } as any,
      { ledgerId: 1, tradeType: 'SELL', platform: 'MANUAL', market: 'HK', symbol: '7709', name: '7709', tradeDate: '2026-06-23', tradeTime: '10:00:00', price: 110, quantity: 9, commission: 0, tax: 0, createdAt: Date.now(), updatedAt: Date.now(), assetType: 'STOCK' } as any,
    ]);

    const summary = await marketCacheManager.detectAndQueueMissingRanges(new Date('2026-07-12T12:00:00Z'));

    expect(summary.items).toContainEqual({ securityKey: 'HK:7709', fromDate: '2026-06-01', toDate: '2026-07-12' });
    const item = await db.marketWorkItems.get('hist_fill_HK_7709_2026-06-01_2026-07-12');
    expect(item?.fetchToDate).toBe('2026-07-12');
  });

  it('ends a fully closed HK position at its liquidation date', async () => {
    await db.transactions.bulkAdd([
      { ledgerId: 1, tradeType: 'BUY', platform: 'MANUAL', market: 'HK', symbol: '7709', name: '7709', tradeDate: '2026-06-01', tradeTime: '10:00:00', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: Date.now(), updatedAt: Date.now(), assetType: 'STOCK' } as any,
      { ledgerId: 1, tradeType: 'SELL', platform: 'MANUAL', market: 'HK', symbol: '7709', name: '7709', tradeDate: '2026-06-23', tradeTime: '10:00:00', price: 110, quantity: 10, commission: 0, tax: 0, createdAt: Date.now(), updatedAt: Date.now(), assetType: 'STOCK' } as any,
    ]);

    const summary = await marketCacheManager.detectAndQueueMissingRanges(new Date('2026-07-12T12:00:00Z'));

    expect(summary.items).toContainEqual({ securityKey: 'HK:7709', fromDate: '2026-06-01', toDate: '2026-06-23' });
  });

  it('should filter out non-quotable records like CASH, CUSTODY, INTEREST', async () => {
    await db.transactions.bulkAdd([
      {
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
        price: 180,
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
      },
      {
        ledgerId: 1,
        tradeType: 'DEPOSIT',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'CASH',
        symbol: 'CASH',
        name: 'Cash Deposit',
        tradeDate: '2024-01-03',
        tradeTime: '10:00:00',
        price: 1000,
        quantity: 1,
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
      },
      {
        ledgerId: 1,
        tradeType: 'INTEREST',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'INTEREST',
        name: 'Interest',
        tradeDate: '2024-01-04',
        tradeTime: '10:00:00',
        price: 5,
        quantity: 1,
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
      },
    ]);

    const summary = await marketCacheManager.detectAndQueueMissingRanges();
    expect(summary.queued).toBe(1);
    expect(summary.items[0].securityKey).toBe('US:AAPL');
  });

  it('should export missing market data merged to one item per security', async () => {
    await db.marketWorkItems.bulkAdd([
      {
        id: 'hist_fill_US_AAPL_2024-01-01_2024-01-02',
        kind: 'historical_range_fill',
        securityKey: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        requiredFromDate: '2024-01-01',
        requiredToDate: '2024-01-02',
        fetchFromDate: '2024-01-01',
        fetchToDate: '2024-01-02',
        sourceReason: 'manual',
        priority: 850,
        status: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'daily_update_US_AAPL_2024-01-03',
        kind: 'daily_close_update',
        securityKey: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2024-01-03',
        sourceReason: 'daily_close_update',
        priority: 700,
        status: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'hist_fill_US_TSLA_2024-01-05_2024-01-10',
        kind: 'historical_range_fill',
        securityKey: 'US:TSLA',
        symbol: 'TSLA',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        requiredFromDate: '2024-01-05',
        requiredToDate: '2024-01-10',
        fetchFromDate: '2024-01-05',
        fetchToDate: '2024-01-10',
        sourceReason: 'manual',
        priority: 850,
        status: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    const { data } = await marketCacheManager.exportMissingMarketData();
    expect(data.version).toBe('missing-market-data-v1');
    // AAPL should be merged into one item covering both range and daily date
    const aapl = data.items.find((item) => item.securityKey === 'US:AAPL');
    expect(aapl).toBeDefined();
    expect(aapl?.requiredFromDate).toBe('2024-01-01');
    expect(aapl?.requiredToDate).toBe('2024-01-03');
    // TSLA remains as one item
    expect(data.items.some((item) => item.securityKey === 'US:TSLA')).toBe(true);
    expect(data.items).toHaveLength(2);
  });

  it('should queue a single historical range task for one security via queueHistoricalRangeForSecurity', async () => {
    await db.transactions.bulkAdd([
      {
        ledgerId: 1,
        tradeType: 'BUY',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        tradeDate: '2024-01-05',
        tradeTime: '10:00:00',
        price: 180,
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
      },
      {
        ledgerId: 1,
        tradeType: 'SELL',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        tradeDate: '2024-01-20',
        tradeTime: '10:00:00',
        price: 190,
        quantity: 5,
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
      },
    ]);

    await marketCacheManager.queueHistoricalRangeForSecurity('AAPL', 'US');

    const items = await db.marketWorkItems.where('kind').equals('historical_range_fill').toArray();
    expect(items).toHaveLength(1);
    expect(items[0].securityKey).toBe('US:AAPL');
    expect(items[0].requiredFromDate).toBe('2024-01-05');
    expect(items[0].requiredToDate).toBe(marketTodayForHistoricalSync('US'));
    expect(items[0].status).toBe('pending');
  });

  it('should filter non-quotable records when queueing for a single security', async () => {
    await db.transactions.bulkAdd([
      {
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
        price: 180,
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
      },
      {
        ledgerId: 1,
        tradeType: 'DEPOSIT',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'CASH',
        symbol: 'CASH',
        name: 'Cash Deposit',
        tradeDate: '2024-01-03',
        tradeTime: '10:00:00',
        price: 1000,
        quantity: 1,
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
      },
      {
        ledgerId: 1,
        tradeType: 'INTEREST',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'INTEREST',
        name: 'Interest',
        tradeDate: '2024-01-04',
        tradeTime: '10:00:00',
        price: 5,
        quantity: 1,
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
      },
    ]);

    await marketCacheManager.queueHistoricalRangeForSecurity('AAPL', 'US');

    const items = await db.marketWorkItems.where('kind').equals('historical_range_fill').toArray();
    expect(items).toHaveLength(1);
    expect(items[0].securityKey).toBe('US:AAPL');
    expect(items[0].requiredFromDate).toBe('2024-01-02');
    expect(items[0].requiredToDate).toBe(marketTodayForHistoricalSync('US'));
  });

  it('should not queue a task when no quotable transactions exist for the security', async () => {
    await db.transactions.bulkAdd([
      {
        ledgerId: 1,
        tradeType: 'BUY',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'TSLA',
        name: 'Tesla Inc.',
        tradeDate: '2024-01-02',
        tradeTime: '10:00:00',
        price: 200,
        quantity: 5,
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
      },
    ]);

    await marketCacheManager.queueHistoricalRangeForSecurity('AAPL', 'US');

    const items = await db.marketWorkItems.where('kind').equals('historical_range_fill').toArray();
    expect(items).toHaveLength(0);
  });
});
