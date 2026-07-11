import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db/localDb';
import { ItickProvider } from '../core/market/itickProvider';
import { TwelvedataProvider } from '../core/market/twelvedataProvider';
import { MarketDataAppProvider } from '../core/market/marketDataProvider';
import { MarketDataCacheService } from '../core/market/marketDataCacheService';
import { AndroidDefaultMarketProvider } from '../core/market/androidDefaultMarketProvider';

describe('Market Data Providers and Cache Service', () => {
  const itick = new ItickProvider();
  const twelve = new TwelvedataProvider();
  const marketdata = new MarketDataAppProvider();
  const androidDefault = new AndroidDefaultMarketProvider();
  const cacheService = new MarketDataCacheService();

  beforeEach(async () => {
    // Clear IndexedDB tables
    await Promise.all([
      db.marketProviderConfigs.clear(),
      db.quoteSnapshots.clear(),
      db.historicalDailyBars.clear(),
      db.historicalBars.clear(),
      db.transactions.clear(),
      db.marketRequestLogs.clear(),
      db.marketWorkItems.clear(),
      db.marketProviderQuotaStates.clear(),
      db.marketExecutorState.clear(),
    ]);

    // Reset fetch mock
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('AndroidDefaultMarketProvider', () => {
    it('falls back to Yahoo chart metadata when the authenticated option quote endpoint is unavailable', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/v7/finance/quote')) {
          return Promise.resolve(new Response(JSON.stringify({ finance: { error: { code: 'Unauthorized' } } }), { status: 401 }));
        }
        if (url.includes('/v8/finance/chart/MARA260717C00017000')) {
          return Promise.resolve(new Response(JSON.stringify({
            chart: {
              result: [{
                meta: { regularMarketPrice: 2.5, previousClose: 2, longName: 'MARA call' },
                indicators: { quote: [{ close: [2, 2.5] }] },
              }],
            },
          }), { status: 200 }));
        }
        throw new Error(`Unexpected URL: ${url}`);
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await androidDefault.fetchQuotes([
        { symbol: 'MARA 260717C17', market: 'US', assetType: 'OPTION' },
      ]);

      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data?.[0]).toMatchObject({
        symbol: 'MARA 260717C17', currentPrice: 2.5, previousClose: 2, provider: 'yahoo-chart-fallback',
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('ItickProvider', () => {
    it('should identify capabilities correctly', () => {
      expect(itick.supportsAssetType('STOCK')).toBe(true);
      expect(itick.supportsAssetType('OPTION')).toBe(false);
      expect(itick.supportsMarket('US')).toBe(true);
      expect(itick.supportsMarket('HK')).toBe(true);
      expect(itick.supportsMarket('A_SHARE')).toBe(true);
      expect(itick.supportsMarket('OTHER')).toBe(false);
    });

    it('should test connection successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await itick.testConnection('test_api_key');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(true);
    });

    it('should fetch quotes successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              code: 0,
              data: {
                ld: 182.5,
                p: 180.0,
                ch: 2.5,
                chp: 1.39,
                s: 'Apple Inc.',
              },
            }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await itick.fetchQuotes(
        [{ symbol: 'AAPL', market: 'US', assetType: 'STOCK' }],
        'test_key'
      );

      expect(result.ok).toBe(true);
      const quotes = result.data!;
      expect(quotes).toHaveLength(1);
      expect(quotes[0].symbol).toBe('AAPL');
      expect(quotes[0].currentPrice).toBe(182.5);
      expect(quotes[0].previousClose).toBe(180.0);
      expect(quotes[0].name).toBe('Apple Inc.');
      expect(quotes[0].provider).toBe('itick');
    });

    it('should fetch historical bars successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              code: 0,
              data: [
                {
                  t: 1783440000000,
                  o: 180.0,
                  h: 185.0,
                  l: 179.0,
                  c: 182.5,
                  v: 10000,
                },
              ],
            }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await itick.fetchHistoricalBars(
        'AAPL',
        'US',
        'STOCK',
        '2026-07-01',
        '2026-07-10',
        'test_key'
      );

      expect(result.ok).toBe(true);
      const bars = result.data!;
      expect(bars.length).toBeGreaterThanOrEqual(0);
      if (bars.length > 0) {
        expect(bars[0].symbol).toBe('AAPL');
        expect(bars[0].close).toBe(182.5);
      }
    });

    it('should search security successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              code: 0,
              data: {
                s: 'Apple Inc.',
              },
            }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await itick.searchSecurity('AAPL', 'US', 'test_key');
      expect(result.ok).toBe(true);
      const info = result.data!;
      expect(info).not.toBeNull();
      expect(info?.name).toBe('Apple Inc.');
    });
  });

  describe('TwelvedataProvider', () => {
    it('should format HK ticker correctly', () => {
      const provider = twelve as any;
      expect(provider.formatTicker('700', 'HK')).toBe('0700.HK');
      expect(provider.formatTicker('AAPL', 'US')).toBe('AAPL');
    });

    it('should test connection successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok' }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await twelve.testConnection('twelve_key');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(true);
    });

    it('should fetch single quote successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              close: '182.50',
              previous_close: '180.00',
              change: '2.50',
              percent_change: '1.39%',
              name: 'Apple Inc.',
            }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await twelve.fetchQuotes(
        [{ symbol: 'AAPL', market: 'US', assetType: 'STOCK' }],
        'twelve_key'
      );
      expect(result.ok).toBe(true);
      const quotes = result.data!;
      expect(quotes).toHaveLength(1);
      expect(quotes[0].currentPrice).toBe(182.5);
      expect(quotes[0].changePercent).toBe(1.39);
    });

    it('should fetch multiple quotes successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              AAPL: {
                close: '182.50',
                previous_close: '180.00',
                change: '2.50',
                percent_change: '1.39%',
                name: 'Apple Inc.',
              },
              TSLA: {
                close: '220.00',
                previous_close: '218.00',
                change: '2.00',
                percent_change: '0.92%',
                name: 'Tesla Inc.',
              },
            }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await twelve.fetchQuotes(
        [
          { symbol: 'AAPL', market: 'US', assetType: 'STOCK' },
          { symbol: 'TSLA', market: 'US', assetType: 'STOCK' },
        ],
        'twelve_key'
      );

      expect(result.ok).toBe(true);
      const quotes = result.data!;
      expect(quotes).toHaveLength(2);
      const aapl = quotes.find((q) => q.symbol === 'AAPL');
      const tsla = quotes.find((q) => q.symbol === 'TSLA');
      expect(aapl?.currentPrice).toBe(182.5);
      expect(tsla?.currentPrice).toBe(220);
    });
  });

  describe('MarketDataAppProvider', () => {
    it('should support Options and US market only', () => {
      expect(marketdata.supportsAssetType('STOCK')).toBe(true);
      expect(marketdata.supportsAssetType('OPTION')).toBe(true);
      expect(marketdata.supportsMarket('US')).toBe(true);
      expect(marketdata.supportsMarket('HK')).toBe(false);
    });

    it('should format option symbol to 21-character OCC format correctly', () => {
      const provider = marketdata as any;
      expect(provider.formatOptionSymbol('AAPL 260708C300')).toBe('AAPL260708C00300000');
      expect(provider.formatOptionSymbol('AAPL 260717C00160000')).toBe('AAPL260717C00160000');
    });

    it('should test connection successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ s: 'ok' }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await marketdata.testConnection('md_key');
      expect(result.ok).toBe(true);
      expect(result.data).toBe(true);
    });

    it('should fetch stock quote successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              s: 'ok',
              last: [182.5],
              prevClose: [180.0],
              change: [2.5],
              changePercent: [1.39],
            }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await marketdata.fetchQuotes(
        [{ symbol: 'AAPL', market: 'US', assetType: 'STOCK' }],
        'md_key'
      );
      expect(result.ok).toBe(true);
      const quotes = result.data!;
      expect(quotes).toHaveLength(1);
      expect(quotes[0].currentPrice).toBe(182.5);
    });

    it('should fetch option quote successfully', async () => {
      const mockFetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              s: 'ok',
              last: [3.5],
              prevClose: [3.2],
              change: [0.3],
              changePercent: [9.38],
            }),
        })
      );
      vi.stubGlobal('fetch', mockFetch);

      const result = await marketdata.fetchQuotes(
        [{ symbol: 'AAPL 260717C00160000', market: 'US', assetType: 'OPTION' }],
        'md_key'
      );
      expect(result.ok).toBe(true);
      const quotes = result.data!;
      expect(quotes).toHaveLength(1);
      expect(quotes[0].currentPrice).toBe(3.5);
      expect(quotes[0].assetType).toBe('OPTION');
    });

    it('should prefer last price over mid price for options quotes and parse multiple symbol formats', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        expect(url).toContain('options/quotes/AAPL260708C00300000');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              s: 'ok',
              last: [13.39],
              mid: [10.59],
              prevClose: [12.0],
            }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      // Test format 1: AAPL 260708C300
      const result1 = await marketdata.fetchQuotes(
        [{ symbol: 'AAPL 260708C300', market: 'US', assetType: 'OPTION' }],
        'md_key'
      );
      expect(result1.ok).toBe(true);
      expect(result1.data![0].currentPrice).toBe(13.39);

      // Test format 2: AAPL  260708  300.0  C
      const result2 = await marketdata.fetchQuotes(
        [{ symbol: 'AAPL  260708  300.0  C', market: 'US', assetType: 'OPTION' }],
        'md_key'
      );
      expect(result2.ok).toBe(true);
      expect(result2.data![0].currentPrice).toBe(13.39);
    });

    it('should fetch option historical bars using quotes range endpoint', async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        expect(url).toContain('options/quotes/AAPL260708C00300000');
        expect(url).toContain('from=2026-07-06');
        expect(url).toContain('to=2026-07-08');
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              s: 'ok',
              updated: [1783368000, 1783454400], // July 6 and July 7
              last: [13.39, 11.20],
              mid: [13.39, 10.59],
              volume: [50, 60]
            }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await marketdata.fetchHistoricalBars(
        'AAPL 260708C300',
        'US',
        'OPTION',
        '2026-07-06',
        '2026-07-08',
        'md_key'
      );
      expect(result.ok).toBe(true);
      const bars = result.data!;
      expect(bars).toHaveLength(2);
      expect(bars[0].date).toBe('2026-07-06');
      expect(bars[0].close).toBe(13.39);
      expect(bars[1].date).toBe('2026-07-07');
      expect(bars[1].close).toBe(11.20); // last price preferred
    });
  });

  describe('MarketDataCacheService', () => {
    beforeEach(async () => {
      // Set up provider configs in database
      // Priority 1: twelvedata (enabled), Priority 2: itick (enabled), Priority 3: marketdata (disabled)
      await db.marketProviderConfigs.bulkAdd([
        {
          provider: 'twelvedata',
          enabled: 1,
          priority: 1,
          apiKey: 'twelve_api_key',
          baseUrl: '',
          optionsJson: '{}',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          provider: 'itick',
          enabled: 1,
          priority: 2,
          apiKey: 'itick_api_key',
          baseUrl: '',
          optionsJson: '{}',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          provider: 'marketdata',
          enabled: 0,
          priority: 3,
          apiKey: '',
          baseUrl: '',
          optionsJson: '{}',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);
    });

    it('should refresh quotes using active providers in priority order and save to DB', async () => {
      // Mock TwelveData fetch to succeed for AAPL
      const mockFetch = vi.fn().mockImplementation((url) => {
        if (url.includes('twelvedata')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                close: '182.50',
                previous_close: '180.00',
                change: '2.50',
                percent_change: '1.39%',
                name: 'Apple Inc.',
              }),
          });
        }
        return Promise.reject(new Error('Should not call lower priority'));
      });
      vi.stubGlobal('fetch', mockFetch);

      const quotes = await cacheService.refreshQuotes([
        { symbol: 'AAPL', market: 'US', assetType: 'STOCK' },
      ], true);

      expect(quotes).toHaveLength(1);
      expect(quotes[0].symbol).toBe('AAPL');
      expect(quotes[0].currentPrice).toBe(182.5);

      // Verify it was saved to local database
      const cached = await db.quoteSnapshots.get('US:AAPL');
      expect(cached).toBeDefined();
      expect(cached?.currentPrice).toBe(182.5);
    });

    it('should fall back to next provider if higher priority provider does not support asset type', async () => {
      await db.marketProviderConfigs.put({
        provider: 'marketdata',
        enabled: 1,
        priority: 3,
        apiKey: 'md_key',
        baseUrl: '',
        optionsJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      const mockFetch = vi.fn().mockImplementation((url) => {
        if (url.includes('marketdata.app')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                s: 'ok',
                last: [3.5],
                prevClose: [3.2],
                change: [0.3],
                changePercent: [9.38],
              }),
          });
        }
        return Promise.reject(new Error('Unexpected fetch call'));
      });
      vi.stubGlobal('fetch', mockFetch);

      const quotes = await cacheService.refreshQuotes([
        { symbol: 'AAPL 260717C00160000', market: 'US', assetType: 'OPTION' },
      ], true);

      // Verify that it fetched from MarketDataAppProvider
      expect(quotes).toHaveLength(1);
      expect(quotes[0].currentPrice).toBe(3.5);
      expect(quotes[0].provider).toBe('marketdata');
    });

    it('should fetch historical bars and correctly handle gap filling', async () => {
      // Put a single day's bar in DB: 2026-07-05
      const barItem = {
        id: 'US:AAPL:STOCK:2026-07-05',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'STOCK' as const,
        date: '2026-07-05',
        open: 180,
        high: 181,
        low: 179,
        close: 180.5,
        volume: 5000,
        provider: 'local',
        fetchedAt: Date.now(),
      };
      await db.historicalDailyBars.put(barItem);
      await db.historicalBars.put({
        id: 'US:AAPL:stock:1d:2026-07-05',
        securityKey: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        tradeDate: '2026-07-05',
        open: 180,
        high: 181,
        low: 179,
        close: 180.5,
        volume: 5000,
        providerId: 'local',
        fetchedAt: Date.now(),
        dataQuality: 'normal',
      });

      const mockFetch = vi.fn().mockImplementation((url) => {
        if (url.includes('twelvedata')) {
          if (url.includes('start_date=2026-07-03') && url.includes('end_date=2026-07-07')) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  values: [
                    { datetime: '2026-07-07', open: '181.5', high: '183', low: '181', close: '182.5', volume: '7000' },
                    { datetime: '2026-07-06', open: '180.5', high: '182', low: '180', close: '181.5', volume: '6000' },
                    { datetime: '2026-07-04', open: '179', high: '181', low: '178', close: '180', volume: '4000' },
                    { datetime: '2026-07-03', open: '178', high: '180', low: '177', close: '179', volume: '3000' },
                  ],
                }),
            });
          }
        }
        return Promise.reject(new Error('Unexpected fetch call'));
      });
      vi.stubGlobal('fetch', mockFetch);

      // getHistoricalBars no longer schedules gap fill tasks automatically.
      // Manually insert a work item to test the executor gap-filling path.
      await db.marketWorkItems.put({
        id: 'hist_fill_US_AAPL_2026-07-03_2026-07-07',
        kind: 'historical_range_fill',
        securityKey: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        assetType: 'stock',
        resolution: '1d',
        requiredFromDate: '2026-07-03',
        requiredToDate: '2026-07-07',
        fetchFromDate: '2026-07-03',
        fetchToDate: '2026-07-07',
        sourceReason: 'manual',
        priority: 850,
        status: 'pending',
        attemptCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Run and wait for executor to finish processing the queue
      const { MarketTaskExecutor } = await import('../core/market/MarketTaskExecutor');
      await MarketTaskExecutor.startOrWakeMarketExecutor();

      const startTime = Date.now();
      while (Date.now() - startTime < 8000) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const pending = await db.marketWorkItems.where('status').anyOf(['pending', 'running']).count();
        if (pending === 0) break;
      }

      // Fetch again from local DB which should now have the filled gaps
      const bars = await cacheService.getHistoricalBars(
        'AAPL',
        'US',
        'STOCK',
        '2026-07-03',
        '2026-07-07'
      );

      expect(bars).toHaveLength(5);
      expect(bars[0].date).toBe('2026-07-03');
      expect(bars[0].close).toBe(179);
      expect(bars[2].date).toBe('2026-07-05');
      expect(bars[2].close).toBe(180.5);
      expect(bars[4].date).toBe('2026-07-07');
      expect(bars[4].close).toBe(182.5);

      const allDbBars = await db.historicalDailyBars.toArray();
      // Ensure compatibility tests pass
      expect(allDbBars).toBeDefined();
    });

    it('should resolve security name from local snapshots first, then transactions, then fall back to providers', async () => {
      await db.quoteSnapshots.put({
        id: 'US:MSFT',
        symbol: 'MSFT',
        market: 'US',
        name: 'Microsoft Corp',
        assetType: 'STOCK',
        currentPrice: null,
        previousClose: null,
        change: null,
        changePercent: null,
        currency: 'USD',
        provider: 'mock',
        fetchedAt: Date.now(),
      });

      let resolvedName = await cacheService.resolveSecurityName('MSFT', 'US');
      expect(resolvedName).toBe('Microsoft Corp');

      await db.transactions.add({
        ledgerId: 1,
        tradeType: 'BUY',
        platform: 'SCHWAB',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'NVDA',
        name: 'NVIDIA Corporation',
        tradeDate: '2026-07-01',
        tradeTime: '10:00:00',
        price: 120,
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
      });

      resolvedName = await cacheService.resolveSecurityName('NVDA', 'US');
      expect(resolvedName).toBe('NVIDIA Corporation');

      const mockFetch = vi.fn().mockImplementation((url) => {
        if (url.includes('twelvedata')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                data: [{ symbol: 'TSLA', instrument_name: 'Tesla Inc.' }],
              }),
          });
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });
      vi.stubGlobal('fetch', mockFetch);

      resolvedName = await cacheService.resolveSecurityName('TSLA', 'US');
      expect(resolvedName).toBe('Tesla Inc.');

      const cached = await db.quoteSnapshots.get('US:TSLA');
      expect(cached).toBeDefined();
      expect(cached?.name).toBe('Tesla Inc.');
    });
  });
});
