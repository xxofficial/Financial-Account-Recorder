import { afterEach, describe, expect, it } from 'vitest';
import type { Transaction } from '../db/schema';
import { applyExpiredOptionCandidates, findExpiredOptionCandidates } from '../core/corporateActions/expiredOptionService';
import { db } from '../db/localDb';

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: Math.floor(Math.random() * 100000),
    ledgerId: 1,
    tradeType: 'BUY',
    platform: 'SCHWAB',
    sourceChannel: null,
    externalReference: null,
    market: 'US',
    symbol: 'AAPL 260117C200',
    name: 'AAPL 2026-01-17 CALL $200',
    tradeDate: '2026-01-01',
    tradeTime: '09:30:00',
    price: 2,
    quantity: 2,
    commission: 0,
    tax: 0,
    note: '',
    createdAt: 1,
    updatedAt: 1,
    investorName: null,
    assetType: 'OPTION',
    underlyingSymbol: 'AAPL',
    expiryDate: '2026-01-17',
    strikePrice: 200,
    optionType: 'CALL',
    contractKey: 'US:OPTION:AAPL:2026-01-17:C:200',
    occSymbol: 'AAPL260117C00200000',
    fxFromCurrency: null,
    fxFromAmount: null,
    fxToCurrency: null,
    fxToAmount: null,
    fxRate: null,
    transferGroupId: null,
    transferCounterpartyPlatform: null,
    ...overrides,
  };
}

afterEach(async () => {
  await db.transactions.clear();
});

describe('expired option corporate action service', () => {
  it('finds non-zero expired positions by platform and contract', () => {
    const candidates = findExpiredOptionCandidates([
      transaction({ id: 1, quantity: 3 }),
      transaction({ id: 2, tradeType: 'SELL', quantity: 1, tradeDate: '2026-01-10' }),
      transaction({ id: 3, platform: 'LONGBRIDGE', quantity: 2 }),
      transaction({ id: 4, expiryDate: '2026-12-31' }),
    ], '2026-07-15');

    expect(candidates).toHaveLength(2);
    expect(candidates.find((candidate) => candidate.platform === 'SCHWAB')?.quantity).toBe(2);
    expect(candidates.find((candidate) => candidate.platform === 'LONGBRIDGE')?.quantity).toBe(2);
  });

  it('does not return an already fully expired position', () => {
    const candidates = findExpiredOptionCandidates([
      transaction({ id: 1, quantity: 2 }),
      transaction({ id: 2, tradeType: 'EXPIRE', quantity: 2, tradeDate: '2026-01-17' }),
    ], '2026-07-15');
    expect(candidates).toEqual([]);
  });

  it('writes confirmed records atomically and remains idempotent', async () => {
    const [candidate] = findExpiredOptionCandidates([transaction()], '2026-07-15');
    expect(await applyExpiredOptionCandidates([candidate])).toBe(1);
    expect(await applyExpiredOptionCandidates([candidate])).toBe(0);
    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].tradeType).toBe('EXPIRE');
    expect(rows[0].sourceChannel).toBe('CORPORATE_ACTION_LOCAL');
    expect(rows[0].quantity).toBe(2);
  });
});
