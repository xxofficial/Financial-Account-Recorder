import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/localDb';
import { 
  LedgerRepository, 
  TransactionRepository, 
  QuoteSnapshotRepository, 
  HistoricalDailyBarRepository, 
  MarketProviderConfigRepository, 
  AppSettingRepository 
} from '../db/repositories';

describe('Database Repositories', () => {
  const ledgerRepo = new LedgerRepository();
  const txnRepo = new TransactionRepository();
  const quoteRepo = new QuoteSnapshotRepository();
  const barRepo = new HistoricalDailyBarRepository();
  const configRepo = new MarketProviderConfigRepository();
  const settingRepo = new AppSettingRepository();

  beforeEach(async () => {
    // Clear and re-populate the database before each test
    await db.ledgers.clear();
    await db.transactions.clear();
    await db.quoteSnapshots.clear();
    await db.historicalBars.clear();
    await db.marketProviderConfigs.clear();
    await db.appSettings.clear();

    // Trigger seed logic manually or simulate the populate callback
    await db.ledgers.add({
      id: 1,
      name: '默认个人账本',
      type: 'PERSONAL',
      description: '首次初始化自动创建的默认个人账本',
      partners: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await db.appSettings.add({
      key: 'default_ledger',
      value: 1,
      updatedAt: Date.now()
    });

    await db.marketProviderConfigs.bulkAdd([
      {
        provider: 'stock-sdk',
        enabled: 0,
        priority: 1,
        apiKey: '',
        baseUrl: 'stock-sdk',
        optionsJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        provider: 'android-default',
        enabled: 0,
        priority: 2,
        apiKey: '',
        baseUrl: 'yahoo',
        optionsJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      {
        provider: 'marketdata',
        enabled: 0,
        priority: 3,
        apiKey: '',
        baseUrl: 'https://api.marketdata.app',
        optionsJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    ]);
  });

  describe('Seeding & Settings', () => {
    it('should have seeded the default ledger and settings', async () => {
      const ledgers = await ledgerRepo.list();
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0].id).toBe(1);
      expect(ledgers[0].name).toBe('默认个人账本');

      const defaultLedgerId = await settingRepo.get('default_ledger');
      expect(defaultLedgerId).toBe(1);

      const configs = await configRepo.list();
      expect(configs).toHaveLength(3);
      expect(configs[0].provider).toBe('stock-sdk');
      expect(configs[0].priority).toBe(1);
    });

    it('should allow setting and retrieving general preferences', async () => {
      await settingRepo.set('theme', 'dark');
      const theme = await settingRepo.get('theme');
      expect(theme).toBe('dark');

      await settingRepo.delete('theme');
      const deletedTheme = await settingRepo.get('theme');
      expect(deletedTheme).toBeUndefined();
    });
  });

  describe('Ledgers CRUD', () => {
    it('should create, update, and list ledgers', async () => {
      const newId = await ledgerRepo.create({
        name: '美股独立账本',
        type: 'PERSONAL',
        description: '专门记美股的账本',
        partners: '',
      });

      const ledger = await ledgerRepo.get(newId);
      expect(ledger).toBeDefined();
      expect(ledger?.name).toBe('美股独立账本');

      await ledgerRepo.update(newId, { name: '美股修改后账本' });
      const updated = await ledgerRepo.get(newId);
      expect(updated?.name).toBe('美股修改后账本');

      const list = await ledgerRepo.list();
      expect(list).toHaveLength(2);
    });
  });

  describe('Transactions CRUD and Search/Filter', () => {
    beforeEach(async () => {
      // Add mock transactions
      await txnRepo.create({
        ledgerId: 1,
        tradeType: 'BUY',
        platform: 'LONGBRIDGE',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        tradeDate: '2026-07-01',
        tradeTime: '10:00:00',
        price: 180.00,
        quantity: 10,
        commission: 1.99,
        tax: 0.50,
        note: '建仓苹果',
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

      await txnRepo.create({
        ledgerId: 1,
        tradeType: 'SELL',
        platform: 'LONGBRIDGE',
        sourceChannel: null,
        externalReference: null,
        market: 'US',
        symbol: 'TSLA',
        name: 'Tesla Inc.',
        tradeDate: '2026-07-02',
        tradeTime: '11:00:00',
        price: 220.00,
        quantity: 5,
        commission: 1.99,
        tax: 0.80,
        note: '平仓特斯拉',
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

      await txnRepo.create({
        ledgerId: 1,
        tradeType: 'BUY',
        platform: 'ZHUORUI',
        sourceChannel: null,
        externalReference: null,
        market: 'HK',
        symbol: '00700',
        name: 'Tencent',
        tradeDate: '2026-07-03',
        tradeTime: '14:00:00',
        price: 330.00,
        quantity: 100,
        commission: 15.00,
        tax: 35.00,
        note: '腾讯建仓',
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
    });

    it('should list transactions by ledger', async () => {
      const txns = await txnRepo.listByLedger(1);
      expect(txns).toHaveLength(3);
    });

    it('should filter transactions by keyword search', async () => {
      const results = await txnRepo.searchAndFilter({ keyword: 'Tesla' });
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('TSLA');
    });

    it('should filter transactions by market', async () => {
      const results = await txnRepo.searchAndFilter({ market: 'HK' });
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('00700');
    });

    it('should filter transactions by platform', async () => {
      const results = await txnRepo.searchAndFilter({ platform: 'ZHUORUI' });
      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('00700');
    });

    it('should filter transactions by date range', async () => {
      const results = await txnRepo.searchAndFilter({ 
        startDate: '2026-07-02', 
        endDate: '2026-07-03' 
      });
      // AAPL is on 07-01 (should be excluded)
      expect(results).toHaveLength(2);
      expect(results[0].symbol).toBe('00700'); // Sorted desc by date
      expect(results[1].symbol).toBe('TSLA');
    });

    it('should delete a transaction and verify removal', async () => {
      const txns = await txnRepo.listByLedger(1);
      const targetId = txns[0].id!;

      await txnRepo.delete(targetId);
      const remaining = await txnRepo.listByLedger(1);
      expect(remaining).toHaveLength(2);
      expect(remaining.find(t => t.id === targetId)).toBeUndefined();
    });

    it('should cascade delete transactions when ledger is deleted', async () => {
      await ledgerRepo.delete(1);
      const txns = await txnRepo.listByLedger(1);
      expect(txns).toHaveLength(0);

      const ledgers = await ledgerRepo.list();
      expect(ledgers).toHaveLength(0);
    });
  });

  describe('QuoteSnapshots Repository', () => {
    it('should get, upsert and list quote snapshots', async () => {
      await quoteRepo.upsert({
        symbol: 'AAPL',
        market: 'US',
        name: 'Apple Inc.',
        assetType: 'STOCK',
        currentPrice: 182.50,
        previousClose: 180.00,
        change: 2.50,
        changePercent: 1.39,
        currency: 'USD',
        provider: 'stock-sdk',
      });

      const snapshot = await quoteRepo.get('US', 'AAPL');
      expect(snapshot).toBeDefined();
      expect(snapshot?.currentPrice).toBe(182.50);

      const list = await quoteRepo.list();
      expect(list).toHaveLength(1);

      await quoteRepo.delete('US', 'AAPL');
      const deleted = await quoteRepo.get('US', 'AAPL');
      expect(deleted).toBeUndefined();
    });
  });

  describe('HistoricalDailyBars Repository', () => {
    it('should bulk upsert and retrieve bars in range', async () => {
      await barRepo.bulkUpsert([
        {
          symbol: 'AAPL',
          market: 'US',
          assetType: 'STOCK',
          date: '2026-07-01',
          open: 179.00,
          high: 181.00,
          low: 178.50,
          close: 180.00,
          volume: 50000000,
          provider: 'stock-sdk',
        },
        {
          symbol: 'AAPL',
          market: 'US',
          assetType: 'STOCK',
          date: '2026-07-02',
          open: 180.00,
          high: 183.00,
          low: 179.50,
          close: 182.50,
          volume: 52000000,
          provider: 'stock-sdk',
        },
        {
          symbol: 'AAPL',
          market: 'US',
          assetType: 'STOCK',
          date: '2026-07-03',
          open: 182.00,
          high: 184.00,
          low: 181.50,
          close: 183.20,
          volume: 45000000,
          provider: 'stock-sdk',
        }
      ]);

      const bars = await barRepo.getRange('US', 'AAPL', 'STOCK', '2026-07-02', '2026-07-05');
      expect(bars).toHaveLength(2);
      expect(bars[0].date).toBe('2026-07-02');
      expect(bars[1].date).toBe('2026-07-03');
    });
  });
});
