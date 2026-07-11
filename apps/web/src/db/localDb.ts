import Dexie, { type Table } from 'dexie';
import {
  Ledger,
  Transaction,
  QuoteSnapshot,
  HistoricalDailyBar,
  MarketProviderConfig,
  AppSetting,
  BackupImportRecord,
  MarketRequestLog,
  HistoricalBar,
  HistoricalCoverage,
  MarketWorkItem,
  MarketProviderQuotaState,
  MarketExecutorState,
  OptionContract,
  OptionDailyBar,
  OptionDailyBarCoverage,
} from './schema';

export class LocalDatabase extends Dexie {
  ledgers!: Table<Ledger, number>;
  transactions!: Table<Transaction, number>;
  quoteSnapshots!: Table<QuoteSnapshot, string>;
  historicalDailyBars!: Table<HistoricalDailyBar, string>;
  marketProviderConfigs!: Table<MarketProviderConfig, string>;
  appSettings!: Table<AppSetting, string>;
  backupImportRecords!: Table<BackupImportRecord, number>;
  marketRequestLogs!: Table<MarketRequestLog, number>;
  historicalBars!: Table<HistoricalBar, string>;
  historicalCoverage!: Table<HistoricalCoverage, number>;
  marketWorkItems!: Table<MarketWorkItem, string>;
  marketProviderQuotaStates!: Table<MarketProviderQuotaState, string>;
  marketExecutorState!: Table<MarketExecutorState, string>;
  optionContracts!: Table<OptionContract, number>;
  optionDailyBars!: Table<OptionDailyBar, string>;
  optionDailyBarCoverage!: Table<OptionDailyBarCoverage, number>;

  constructor() {
    super('StockLedgerDatabase');
    this.version(1).stores({
      ledgers: '++id, name, type, createdAt',
      transactions: '++id, ledgerId, tradeDate, symbol, market, platform, [ledgerId+tradeDate], [market+symbol]',
      quoteSnapshots: 'id, symbol, market, [market+symbol]',
      historicalDailyBars: 'id, symbol, market, date, [market+symbol+date], [symbol+market+assetType+date]',
      marketProviderConfigs: 'provider, enabled, priority',
      appSettings: 'key',
      backupImportRecords: '++id, fileName, importedAt',
    });

    // Version 2: Migrate boolean `enabled` to number (0/1)
    // IndexedDB does not support boolean as indexable key types
    this.version(2).stores({
      ledgers: '++id, name, type, createdAt',
      transactions: '++id, ledgerId, tradeDate, symbol, market, platform, [ledgerId+tradeDate], [market+symbol]',
      quoteSnapshots: 'id, symbol, market, [market+symbol]',
      historicalDailyBars: 'id, symbol, market, date, [market+symbol+date], [symbol+market+assetType+date]',
      marketProviderConfigs: 'provider, enabled, priority',
      appSettings: 'key',
      backupImportRecords: '++id, fileName, importedAt',
    }).upgrade(tx => {
      return tx.table('marketProviderConfigs').toCollection().modify(config => {
        if (typeof config.enabled === 'boolean') {
          config.enabled = config.enabled ? 1 : 0;
        }
      });
    });

    // Version 3: Add marketRequestLogs table
    this.version(3).stores({
      ledgers: '++id, name, type, createdAt',
      transactions: '++id, ledgerId, tradeDate, symbol, market, platform, [ledgerId+tradeDate], [market+symbol]',
      quoteSnapshots: 'id, symbol, market, [market+symbol]',
      historicalDailyBars: 'id, symbol, market, date, [market+symbol+date], [symbol+market+assetType+date]',
      marketProviderConfigs: 'provider, enabled, priority',
      appSettings: 'key',
      backupImportRecords: '++id, fileName, importedAt',
      marketRequestLogs: '++id, provider, requestType, requestKey, status, createdAt',
    });

    // Version 4: Add historicalBars, historicalCoverage, marketWorkItems, marketProviderQuotaStates, marketExecutorState tables
    this.version(4).stores({
      ledgers: '++id, name, type, createdAt',
      transactions: '++id, ledgerId, tradeDate, symbol, market, platform, [ledgerId+tradeDate], [market+symbol]',
      quoteSnapshots: 'id, symbol, market, [market+symbol]',
      historicalDailyBars: 'id, symbol, market, date, [market+symbol+date], [symbol+market+assetType+date]',
      marketProviderConfigs: 'provider, enabled, priority',
      appSettings: 'key',
      backupImportRecords: '++id, fileName, importedAt',
      marketRequestLogs: '++id, providerId, type, createdAt',
      historicalBars: 'id, securityKey, symbol, market, assetType, resolution, tradeDate, [securityKey+resolution+tradeDate]',
      historicalCoverage: '++id, securityKey, [securityKey+resolution]',
      marketWorkItems: 'id, kind, status, priority, nextRetryAt, securityKey, [securityKey+kind], [securityKey+resolution], [status+priority]',
      marketProviderQuotaStates: 'providerId',
      marketExecutorState: 'id',
    }).upgrade(async tx => {
      const oldBars = await tx.table('historicalDailyBars').toArray();
      const newBarsTable = tx.table('historicalBars');
      for (const bar of oldBars) {
        const assetTypeMapped = (bar.assetType || 'STOCK').toLowerCase() as any;
        const resolutionMapped = '1d';
        const newBar = {
          id: `${bar.market}:${bar.symbol}:${assetTypeMapped}:${resolutionMapped}:${bar.date}`,
          securityKey: `${bar.market}:${bar.symbol}`,
          symbol: bar.symbol,
          market: bar.market,
          assetType: assetTypeMapped,
          resolution: resolutionMapped,
          tradeDate: bar.date,
          open: bar.open ?? undefined,
          high: bar.high ?? undefined,
          low: bar.low ?? undefined,
          close: bar.close,
          volume: bar.volume ?? undefined,
          providerId: bar.provider || 'unknown',
          fetchedAt: bar.fetchedAt || Date.now(),
          dataQuality: 'normal' as const
        };
        await newBarsTable.put(newBar);
      }
    });

    // Version 6: Add option-specific tables
    this.version(6).stores({
      ledgers: '++id, name, type, createdAt',
      transactions: '++id, ledgerId, tradeDate, symbol, market, platform, [ledgerId+tradeDate], [market+symbol]',
      quoteSnapshots: 'id, symbol, market, [market+symbol]',
      historicalDailyBars: 'id, symbol, market, date, [market+symbol+date], [symbol+market+assetType+date]',
      marketProviderConfigs: 'provider, enabled, priority',
      appSettings: 'key',
      backupImportRecords: '++id, fileName, importedAt',
      marketRequestLogs: '++id, providerId, type, createdAt',
      historicalBars: 'id, securityKey, symbol, market, assetType, resolution, tradeDate, [securityKey+resolution+tradeDate]',
      historicalCoverage: '++id, securityKey, [securityKey+resolution], updatedAt',
      marketWorkItems: 'id, kind, status, priority, nextRetryAt, securityKey, contractKey, [securityKey+kind], [contractKey+kind], [status+priority]',
      marketProviderQuotaStates: 'providerId',
      marketExecutorState: 'id',
      optionContracts: '++id, contractKey, occSymbol, providerSymbol, underlying, expirationDate, [underlying+expirationDate], [underlying+expirationDate+side+strike]',
      optionDailyBars: 'id, contractKey, occSymbol, providerSymbol, tradeDate, [contractKey+tradeDate], [occSymbol+tradeDate], [underlying+tradeDate], [expirationDate+tradeDate]',
      optionDailyBarCoverage: '++id, contractKey, [contractKey+fromDate], [contractKey+toDate]',
    });

    // Version 7: Add stable backup identities without changing local primary keys.
    this.version(7).stores({
      ledgers: '++id, syncId, name, type, createdAt',
      transactions: '++id, syncId, sourceFingerprint, ledgerId, tradeDate, symbol, market, platform, [ledgerId+tradeDate], [market+symbol], [platform+externalReference]',
      quoteSnapshots: 'id, symbol, market, [market+symbol]',
      historicalDailyBars: 'id, symbol, market, date, [market+symbol+date], [symbol+market+assetType+date]',
      marketProviderConfigs: 'provider, enabled, priority',
      appSettings: 'key',
      backupImportRecords: '++id, fileName, importedAt',
      marketRequestLogs: '++id, providerId, type, createdAt',
      historicalBars: 'id, securityKey, symbol, market, assetType, resolution, tradeDate, [securityKey+resolution+tradeDate]',
      historicalCoverage: '++id, securityKey, [securityKey+resolution], updatedAt',
      marketWorkItems: 'id, kind, status, priority, nextRetryAt, securityKey, contractKey, [securityKey+kind], [contractKey+kind], [status+priority]',
      marketProviderQuotaStates: 'providerId',
      marketExecutorState: 'id',
      optionContracts: '++id, contractKey, occSymbol, providerSymbol, underlying, expirationDate, [underlying+expirationDate], [underlying+expirationDate+side+strike]',
      optionDailyBars: 'id, contractKey, occSymbol, providerSymbol, tradeDate, [contractKey+tradeDate], [occSymbol+tradeDate], [underlying+tradeDate], [expirationDate+tradeDate]',
      optionDailyBarCoverage: '++id, contractKey, [contractKey+fromDate], [contractKey+toDate]',
    });
  }
}

export const db = new LocalDatabase();

// Database seed logic on first creation
db.on('populate', (tx) => {
  // Use transaction to ensure atomic seeding
  tx.table('ledgers').add({
    id: 1,
    name: '默认个人账本',
    type: 'PERSONAL',
    description: '首次初始化自动创建的默认个人账本',
    partners: '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  tx.table('appSettings').add({
    key: 'default_ledger',
    value: 1,
    updatedAt: Date.now()
  });

  tx.table('marketProviderConfigs').bulkAdd([
    {
      provider: 'itick',
      enabled: 0,
      priority: 1,
      apiKey: '',
      baseUrl: 'https://api.itick.org',
      optionsJson: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    {
      provider: 'twelvedata',
      enabled: 0,
      priority: 2,
      apiKey: '',
      baseUrl: 'https://api.twelvedata.com',
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
