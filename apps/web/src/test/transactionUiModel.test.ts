import { describe, expect, it } from 'vitest';
import type { Transaction } from '../db/schema';
import { mapTransactionToUiModel } from '../shared/models';

const transaction = (overrides: Partial<Transaction>): Transaction => ({
  ledgerId: 1,
  tradeType: 'OTHER',
  platform: 'SCHWAB',
  sourceChannel: 'CSV_TEXT',
  externalReference: null,
  market: 'US',
  symbol: 'CASH',
  name: '',
  tradeDate: '2026-06-29',
  tradeTime: '21:35:00',
  price: 1,
  quantity: 1,
  commission: 0,
  tax: 0,
  note: '',
  createdAt: 0,
  updatedAt: 0,
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

describe('cash transaction UI semantics', () => {
  it('shows financing interest as an outflow and preserves signed OTHER cash actions', () => {
    expect(mapTransactionToUiModel(transaction({ tradeType: 'INTEREST', symbol: 'INTEREST', name: '融资利息', price: 77.14 }))).toMatchObject({
      amountLabel: '-$77.14',
      amountTone: 'NEGATIVE',
      displayTypeLabel: '融资利息',
    });
    expect(mapTransactionToUiModel(transaction({ name: 'Credit Interest', price: 0.01 }))).toMatchObject({
      amountLabel: '+$0.01',
      amountTone: 'POSITIVE',
    });
    expect(mapTransactionToUiModel(transaction({ name: 'ADR Mgmt Fee', price: -2.25 }))).toMatchObject({
      amountLabel: '-$2.25',
      amountTone: 'NEGATIVE',
    });
  });
});
