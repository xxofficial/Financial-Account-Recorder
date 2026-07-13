import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db/localDb';
import { backupService, BackupData } from '../core/backup/backupService';
import { Transaction } from '../db/schema';

describe('Backup and Restore Service', () => {
  beforeEach(async () => {
    // Clear IndexedDB tables
    await db.ledgers.clear();
    await db.transactions.clear();
    await db.quoteSnapshots.clear();
    await db.historicalBars.clear();
    await db.appSettings.clear();
    await db.marketProviderConfigs.clear();
    await db.backupImportRecords.clear();

    // Seed basic default ledger and default currency setting
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
      key: 'display_currency',
      value: 'CNY',
      updatedAt: Date.now()
    });
  });

  it('should export database successfully', async () => {
    // Add a mock transaction
    await db.transactions.add({
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'MANUAL',
      sourceChannel: null,
      externalReference: null,
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 180.0,
      quantity: 10,
      commission: 1.0,
      tax: 0.5,
      note: 'Test export txn',
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
      fxRate: null
    } as Transaction);

    const exported = await backupService.exportBackup();
    expect(exported.version).toBe(5);
    expect(exported.format).toBe('recoder-backup-v5');
    expect(exported.displayCurrency).toBe('CNY');
    expect(exported.ledgers).toHaveLength(1);
    expect(exported.ledgers[0].name).toBe('默认个人账本');
    expect(exported.transactions).toHaveLength(1);
    expect(exported.transactions[0].symbol).toBe('AAPL');
  });

  it('should parse and validate backup JSON successfully', () => {
    const mockBackupData: BackupData = {
      version: 4,
      displayCurrency: 'USD',
      enabledPlatforms: ['MANUAL'],
      ledgers: [
        { id: 1, name: 'Personal Ledger', type: 'PERSONAL', description: '', partners: '', createdAt: Date.now(), updatedAt: Date.now() }
      ],
      transactions: [
        {
          ledgerId: 1,
          tradeType: 'BUY',
          platform: 'MANUAL',
          sourceChannel: null,
          externalReference: null,
          market: 'US',
          symbol: 'TSLA',
          name: 'Tesla Inc.',
          tradeDate: '2026-07-02',
          tradeTime: '14:30:00',
          price: 220.0,
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
          fxRate: null
        } as Transaction,
        {
          ledgerId: 1,
          tradeType: 'SELL',
          platform: 'MANUAL',
          sourceChannel: null,
          externalReference: null,
          market: 'US',
          symbol: 'TSLA',
          name: 'Tesla Inc.',
          tradeDate: '2026-07-03',
          tradeTime: '15:00:00',
          price: 230.0,
          quantity: 2,
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
          fxRate: null
        } as Transaction
      ]
    };

    const jsonStr = JSON.stringify(mockBackupData);
    const preview = backupService.parseBackup(jsonStr);

    expect(preview.version).toBe(4);
    expect(preview.displayCurrency).toBe('USD');
    expect(preview.ledgersCount).toBe(1);
    expect(preview.transactionsCount).toBe(2);
    expect(preview.dateRange).toBe('2026-07-02 ~ 2026-07-03');
    expect(preview.tradeTypeBreakdown.BUY).toBe(1);
    expect(preview.tradeTypeBreakdown.SELL).toBe(1);
    expect(preview.previewTransactions).toHaveLength(2);
    expect(preview.previewTransactions[0].symbol).toBe('TSLA');
  });

  it('does not export provider keys or unrelated sensitive settings', async () => {
    await db.marketProviderConfigs.put({
      provider: 'itick',
      enabled: 1,
      priority: 1,
      apiKey: 'very-secret-market-key',
      baseUrl: 'https://api.itick.org',
      optionsJson: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.appSettings.put({ key: 'email_password', value: 'very-secret-email-password', updatedAt: Date.now() });

    const serialized = JSON.stringify(await backupService.exportBackup());
    expect(serialized).not.toContain('very-secret-market-key');
    expect(serialized).not.toContain('very-secret-email-password');
  });

  it('detects repeated v5 imports and same-UUID content conflicts without overwriting', async () => {
    await db.transactions.add({
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'MANUAL',
      sourceChannel: null,
      externalReference: null,
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      tradeDate: '2026-07-01',
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
    } as Transaction);
    const original = await backupService.exportBackup();

    const repeated = await backupService.importBackup(original, 'APPEND', 'repeat-v5.json');
    expect(repeated.transactionCount).toBe(0);
    expect(repeated.duplicateCount).toBe(1);

    const conflicting = structuredClone(original);
    conflicting.transactions[0].price = 181;
    const conflictResult = await backupService.importBackup(conflicting, 'APPEND', 'conflict-v5.json');
    expect(conflictResult.transactionCount).toBe(0);
    expect(conflictResult.conflictCount).toBe(1);
    expect((await db.transactions.toArray())[0].price).toBe(180);
  });

  it('should handle OVERWRITE import successfully', async () => {
    // Setup initial data in DB that should be cleared
    await db.appSettings.put({ key: 'default_ledger', value: 1, updatedAt: Date.now() });
    await db.transactions.add({
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'MANUAL',
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 180.0,
      quantity: 10,
      commission: 1.0,
      tax: 0.5,
      note: 'Old transaction',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      assetType: 'STOCK'
    } as Transaction);

    const mockBackupData: BackupData = {
      version: 4,
      displayCurrency: 'USD',
      enabledPlatforms: ['LONGBRIDGE'],
      ledgers: [
        { id: 2, name: 'New Imported Ledger', type: 'PERSONAL', description: '', partners: '', createdAt: Date.now(), updatedAt: Date.now() }
      ],
      transactions: [
        {
          ledgerId: 2,
          tradeType: 'BUY',
          platform: 'LONGBRIDGE',
          market: 'US',
          symbol: 'TSLA',
          name: 'Tesla Inc.',
          tradeDate: '2026-07-02',
          tradeTime: '14:30:00',
          price: 220.0,
          quantity: 5,
          commission: 0,
          tax: 0,
          note: 'New transaction',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          assetType: 'STOCK'
        } as Transaction
      ]
    };

    const res = await backupService.importBackup(mockBackupData, 'OVERWRITE', 'test_backup.json');
    expect(res.ledgerCount).toBe(1);
    expect(res.transactionCount).toBe(1);

    // Verify old transaction is cleared and new is inserted
    const txns = await db.transactions.toArray();
    expect(txns).toHaveLength(1);
    expect(txns[0].symbol).toBe('TSLA');
    expect(txns[0].note).toBe('New transaction');

    // Verify ledgers are overwritten
    const ledgers = await db.ledgers.toArray();
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0].name).toBe('New Imported Ledger');

    // The previously selected ledger was deleted by overwrite; select the
    // imported ledger so portfolio and transaction pages show restored data.
    const defaultLedger = await db.appSettings.get('default_ledger');
    expect(defaultLedger?.value).toBe(ledgers[0].id);

    // Verify settings updated
    const displayCurrency = await db.appSettings.get('display_currency');
    expect(displayCurrency?.value).toBe('USD');

    // Verify import record was logged
    const records = await db.backupImportRecords.toArray();
    expect(records).toHaveLength(1);
    expect(records[0].fileName).toBe('test_backup.json');
    expect(records[0].status).toBe('SUCCESS');
  });

  it('should handle APPEND import successfully with ledger remapping', async () => {
    // Old ledger: id=1, name='默认个人账本'
    // Old transaction:
    await db.transactions.add({
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'MANUAL',
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 180.0,
      quantity: 10,
      commission: 1.0,
      tax: 0.5,
      note: 'Old transaction',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      assetType: 'STOCK'
    } as Transaction);

    const mockBackupData: BackupData = {
      version: 4,
      displayCurrency: 'USD',
      enabledPlatforms: ['LONGBRIDGE'],
      ledgers: [
        { id: 1, name: '默认个人账本', type: 'PERSONAL', description: '', partners: '', createdAt: Date.now(), updatedAt: Date.now() },
        { id: 2, name: 'New Imported Ledger', type: 'PERSONAL', description: '', partners: '', createdAt: Date.now(), updatedAt: Date.now() }
      ],
      transactions: [
        {
          ledgerId: 2,
          tradeType: 'BUY',
          platform: 'LONGBRIDGE',
          market: 'US',
          symbol: 'TSLA',
          name: 'Tesla Inc.',
          tradeDate: '2026-07-02',
          tradeTime: '14:30:00',
          price: 220.0,
          quantity: 5,
          commission: 0,
          tax: 0,
          note: 'Appended transaction',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          assetType: 'STOCK'
        } as Transaction
      ]
    };

    const res = await backupService.importBackup(mockBackupData, 'APPEND', 'test_append.json');
    // Remaps '默认个人账本' (exists, no new insert), inserts 'New Imported Ledger' (new insert, ledgerCount = 1)
    expect(res.ledgerCount).toBe(1);
    expect(res.transactionCount).toBe(1);

    // Verify both old and new transactions exist
    const txns = await db.transactions.toArray();
    expect(txns).toHaveLength(2);
    
    const tslaTx = txns.find(t => t.symbol === 'TSLA')!;
    expect(tslaTx.note).toBe('Appended transaction');
    
    // Verify ledger mapping: TSLA txn ledgerId should be mapped to the new generated ledger ID
    const ledgers = await db.ledgers.toArray();
    expect(ledgers).toHaveLength(2);
    
    const newLedger = ledgers.find(l => l.name === 'New Imported Ledger')!;
    expect(tslaTx.ledgerId).toBe(newLedger.id);
  });
});
