import { afterEach, describe, expect, it } from 'vitest';
import type { Transaction } from '../db/schema';
import { applySplitCandidates, buildSplitCandidates, CORPORATE_ACTION_PENDING_SPLITS_KEY, dueCorporateActionMarkets, eligibleCorporateActionCycle, getPendingSplitEvents, parseMassiveSplitEvents, parseYahooSplitEvents, ratioFromDividendDetail } from '../core/corporateActions/splitActionService';
import { db } from '../db/localDb';

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    ledgerId: 1,
    tradeType: 'BUY',
    platform: 'SCHWAB',
    sourceChannel: null,
    externalReference: null,
    market: 'US',
    symbol: 'AAPL',
    name: 'Apple',
    tradeDate: '2024-01-01',
    tradeTime: '09:30:00',
    price: 100,
    quantity: 2,
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
    contractKey: null,
    occSymbol: null,
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
  await db.appSettings.delete(CORPORATE_ACTION_PENDING_SPLITS_KEY);
});

describe('split corporate action service', () => {
  it('converts A-share 10-for-5 bonus/transfer into a 1.5 multiplier', () => {
    expect(ratioFromDividendDetail({ assignTransferRatio: 5 })).toBe(1.5);
    expect(ratioFromDividendDetail({ bonusRatio: 2, transferRatio: 3 })).toBe(1.5);
    expect(ratioFromDividendDetail({ bonusRatio: 0, transferRatio: 0 })).toBeNull();
  });

  it('parses Yahoo split events in the chart response shape', () => {
    const events = parseYahooSplitEvents({ chart: { result: [{ meta: { symbol: 'AAPL' }, events: { splits: {
      x: { date: 1710000000, numerator: 2, denominator: 1, splitRatio: '2:1' },
    } } }] } }, 'US', 'AAPL');
    expect(events).toHaveLength(1);
    expect(events[0].ratio).toBe(2);
    expect(events[0].externalReference).toContain('corporate-split:yahoo-chart:US:AAPL');
  });

  it('parses Massive US split events, including SNXX 1-for-8 on its execution date', () => {
    const events = parseMassiveSplitEvents({ results: [{ ticker: 'SNXX', execution_date: '2026-06-03', split_from: 1, split_to: 8, adjustment_type: 'forward_split', historical_adjustment_factor: 0.125 }] }, 'SNXX');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ market: 'US', symbol: 'SNXX', tradeDate: '2026-06-03', ratio: 8, source: 'massive-splits' });
    expect(events[0].externalReference).toContain('corporate-split:massive-splits:US:SNXX:2026-06-03:8');
  });

  it('parses Massive reverse splits as a sub-unit multiplier', () => {
    const [event] = parseMassiveSplitEvents({ results: [{ ticker: 'TEST', execution_date: '2026-01-02', split_from: 10, split_to: 1 }] }, 'TEST');
    expect(event.ratio).toBe(0.1);
  });

  it('builds per-platform candidates and writes them idempotently', async () => {
    const transactions = [transaction({ id: 1, platform: 'SCHWAB' }), transaction({ id: 2, platform: 'LONGBRIDGE' })];
    const [event] = parseYahooSplitEvents({ chart: { result: [{ events: { splits: { x: { date: 1710000000, numerator: 2, denominator: 1 } } } }] } }, 'US', 'AAPL');
    const candidates = buildSplitCandidates(transactions, [event]);
    expect(candidates.map((candidate) => candidate.platform)).toEqual(['SCHWAB', 'LONGBRIDGE']);
    expect(await applySplitCandidates(candidates)).toBe(2);
    expect(await applySplitCandidates(candidates)).toBe(0);
    expect((await db.transactions.toArray()).filter((transaction) => transaction.tradeType === 'SPLIT')).toHaveLength(2);
  });

  it('does not duplicate a manually entered split with the same event fields', () => {
    const [event] = parseYahooSplitEvents({ chart: { result: [{ events: { splits: { x: { date: 1710000000, numerator: 2, denominator: 1 } } } }] } }, 'US', 'AAPL');
    const candidates = buildSplitCandidates([transaction({ tradeType: 'SPLIT', tradeDate: event.tradeDate, price: event.ratio })], [event]);
    expect(candidates).toEqual([]);
  });

  it('uses post-close Beijing-time windows and attempts each market only once per cycle', () => {
    const beforeAsiaClose = new Date('2026-07-15T09:59:00.000Z'); // 17:59 Asia/Shanghai
    const afterAsiaClose = new Date('2026-07-15T10:00:00.000Z'); // 18:00 Asia/Shanghai
    expect(eligibleCorporateActionCycle('A_SHARE', beforeAsiaClose)).toBe('2026-07-14');
    expect(eligibleCorporateActionCycle('A_SHARE', afterAsiaClose)).toBe('2026-07-15');
    expect(dueCorporateActionMarkets({ lastAttemptCycle: { A_SHARE: '2026-07-15', HK: '2026-07-15', US: '2026-07-15' } }, afterAsiaClose)).toEqual([]);
  });

  it('reads persisted candidates for a selected ledger', async () => {
    const [event] = parseYahooSplitEvents({ chart: { result: [{ events: { splits: { x: { date: 1710000000, numerator: 2, denominator: 1 } } } }] } }, 'US', 'AAPL');
    await db.appSettings.put({ key: CORPORATE_ACTION_PENDING_SPLITS_KEY, value: [{ ledgerId: 1, event, storedAt: 1 }, { ledgerId: 2, event: { ...event, externalReference: `${event.externalReference}:other` }, storedAt: 1 }], updatedAt: 1 });
    expect(await getPendingSplitEvents(1)).toEqual([event]);
    expect(await getPendingSplitEvents(0)).toHaveLength(2);
  });
});
