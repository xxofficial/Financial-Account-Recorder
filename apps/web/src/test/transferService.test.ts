import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/localDb';
import { createTransferPair, deleteTransferPairByTransactionId, getTransferPairByTransactionId, TransferValidationError, updateTransferPair } from '../core/transfers/transferService';
import type { Transaction } from '../db/schema';

const baseTransaction = (overrides: Partial<Transaction>): Transaction => ({
  ledgerId: 1,
  tradeType: 'BUY',
  platform: 'LONGBRIDGE',
  sourceChannel: null,
  externalReference: null,
  market: 'US',
  symbol: 'AAPL',
  name: 'Apple',
  tradeDate: '2026-07-01',
  tradeTime: '10:00:00',
  price: 100,
  quantity: 10,
  commission: 0,
  tax: 0,
  note: '',
  createdAt: 1,
  updatedAt: 1,
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
  ...overrides,
});

describe('transfer service', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.ledgers.clear();
    await db.ledgers.add({ id: 1, name: '测试账本', type: 'PERSONAL', description: '', partners: '', createdAt: 1, updatedAt: 1 });
  });

  it('creates a stock pair at the source average cost and links both rows', async () => {
    await db.transactions.add(baseTransaction({ createdAt: 1 }));
    const pair = await createTransferPair({
      ledgerId: 1,
      sourcePlatform: 'LONGBRIDGE',
      targetPlatform: 'SCHWAB',
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple',
      tradeDate: '2026-07-02',
      tradeTime: '10:00:00',
      isSecurity: true,
      quantity: 4,
      assetType: 'STOCK',
      commission: 2,
      tax: 0,
    });

    expect(pair.out.tradeType).toBe('TRANSFER_OUT');
    expect(pair.in.tradeType).toBe('TRANSFER_IN');
    expect(pair.out.price).toBe(100);
    expect(pair.in.price).toBe(100);
    expect(pair.out.transferGroupId).toBe(pair.groupId);
    expect(pair.in.transferGroupId).toBe(pair.groupId);
    expect(pair.out.transferCounterpartyPlatform).toBe('SCHWAB');
    expect(await db.transactions.count()).toBe(3);
  });

  it('rejects a transfer that exceeds source cash and leaves no partial pair', async () => {
    await db.transactions.add(baseTransaction({ tradeType: 'DEPOSIT', symbol: 'CASH', name: '现金', price: 100, quantity: 1, createdAt: 1 }));
    await expect(createTransferPair({
      ledgerId: 1,
      sourcePlatform: 'LONGBRIDGE',
      targetPlatform: 'SCHWAB',
      market: 'US',
      symbol: 'CASH',
      name: '现金',
      tradeDate: '2026-07-02',
      tradeTime: '10:00:00',
      isSecurity: false,
      quantity: 1,
      amount: 99,
      commission: 2,
      tax: 0,
    })).rejects.toBeInstanceOf(TransferValidationError);
    expect(await db.transactions.count()).toBe(1);
  });

  it('updates and deletes both sides atomically', async () => {
    await db.transactions.add(baseTransaction({ createdAt: 1 }));
    const pair = await createTransferPair({
      ledgerId: 1,
      sourcePlatform: 'LONGBRIDGE',
      targetPlatform: 'SCHWAB',
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple',
      tradeDate: '2026-07-02',
      tradeTime: '10:00:00',
      isSecurity: true,
      quantity: 2,
    });
    const updated = await updateTransferPair(pair.groupId, {
      ledgerId: 1,
      sourcePlatform: 'LONGBRIDGE',
      targetPlatform: 'HSBC',
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple',
      tradeDate: '2026-07-03',
      tradeTime: '10:00:00',
      isSecurity: true,
      quantity: 1,
    });
    expect(updated.in.platform).toBe('HSBC');
    expect((await getTransferPairByTransactionId(updated.out.id!))?.in.platform).toBe('HSBC');
    await deleteTransferPairByTransactionId(updated.out.id!);
    expect(await db.transactions.count()).toBe(1);
  });
});
