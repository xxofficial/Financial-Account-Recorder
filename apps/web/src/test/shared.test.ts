import { describe, it, expect } from 'vitest';
import { 
  Market, 
  getMarketFromString, 
  TradeTypeLabels, 
  isSecurityTrade, 
  isCashFlowPositive, 
  BrokerPlatform, 
  mapTransactionToUiModel 
} from '../shared/models';
import { 
  transactionSchema, 
  ledgerSchema 
} from '../shared/schemas';
import { Transaction } from '../db/schema';

describe('Shared Models & Enums', () => {
  it('should resolve market properties correctly', () => {
    expect(Market.US.label).toBe('美股');
    expect(Market.US.currencySymbol).toBe('$');
    expect(Market.US.toCnyRate).toBe(7.20);

    expect(getMarketFromString('HK')).toEqual(Market.HK);
    expect(getMarketFromString('HONG_KONG')).toEqual(Market.HK);
    expect(getMarketFromString('invalid')).toBeUndefined();
  });

  it('should identify trade type traits correctly', () => {
    expect(TradeTypeLabels.BUY).toBe('买入');
    expect(isSecurityTrade('BUY')).toBe(true);
    expect(isSecurityTrade('DIVIDEND')).toBe(false);

    expect(isCashFlowPositive('SELL')).toBe(true);
    expect(isCashFlowPositive('BUY')).toBe(false);
  });

  it('should resolve platforms lists', () => {
    expect(BrokerPlatform.LONGBRIDGE.label).toBe('长桥证券');
    expect(BrokerPlatform.LONGBRIDGE.supportsPdfImport).toBe(true);
  });
});

describe('Transaction To UI Mapper', () => {
  it('should map a BUY transaction correctly', () => {
    const txn: Transaction = {
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ui = mapTransactionToUiModel(txn);
    expect(ui.stockName).toBe('Apple Inc.');
    expect(ui.primaryMeta).toBe('10 股 @ 180.00');
    expect(ui.amountLabel).toBe('-$1,802.49'); // 10*180 + 1.99 + 0.50 = 1802.49
    expect(ui.amountTone).toBe('NEGATIVE');
    expect(ui.platformLabel).toBe('长桥');
    expect(ui.timeLabel).toBe('2026-07-01 10:00');
  });

  it('should map a SELL transaction correctly', () => {
    const txn: Transaction = {
      ledgerId: 1,
      tradeType: 'SELL',
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
      note: '卖出腾讯',
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ui = mapTransactionToUiModel(txn);
    expect(ui.amountLabel).toBe('+HK$32,950.00'); // 100*330 - 15 - 35 = 32950
    expect(ui.amountTone).toBe('POSITIVE');
  });

  it('should map an OPTION transaction correctly', () => {
    const txn: Transaction = {
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'LONGBRIDGE',
      sourceChannel: null,
      externalReference: null,
      market: 'US',
      symbol: 'AAPL 260717C180',
      name: 'AAPL 180 CALL',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 5.50,
      quantity: 1,
      commission: 1.00,
      tax: 0.20,
      note: '买入看涨期权',
      investorName: null,
      assetType: 'OPTION',
      underlyingSymbol: 'AAPL',
      expiryDate: '2026-07-17',
      strikePrice: 180.00,
      optionType: 'CALL',
      fxFromCurrency: null,
      fxFromAmount: null,
      fxToCurrency: null,
      fxToAmount: null,
      fxRate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ui = mapTransactionToUiModel(txn);
    expect(ui.secondaryMeta).toBe('看涨期权 | 行权价: 180.00 | 到期: 2026-07-17');
  });
});

describe('Zod Validation Schemas', () => {
  it('should validate a correct stock transaction', () => {
    const validData = {
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'LONGBRIDGE',
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 180.00,
      quantity: 10,
      commission: 1.99,
      tax: 0.50,
      note: '正常买入',
      assetType: 'STOCK',
    };

    const result = transactionSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('should fail validation with invalid values', () => {
    const invalidData = {
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'LONGBRIDGE',
      market: 'US',
      symbol: '', // Empty symbol
      name: 'Apple Inc.',
      tradeDate: '2026/07/01', // Bad format
      tradeTime: '10:00:00',
      price: -5.00, // Negative price
      quantity: 10,
    };

    const result = transactionSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorPaths = result.error.issues.map(i => i.path[0]);
      expect(errorPaths).toContain('symbol');
      expect(errorPaths).toContain('tradeDate');
      expect(errorPaths).toContain('price');
    }
  });

  it('should apply conditional checks on OPTION asset types', () => {
    const missingOptionFields = {
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'LONGBRIDGE',
      market: 'US',
      symbol: 'AAPL 260717C180',
      name: 'AAPL 180 CALL',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 5.50,
      quantity: 1,
      assetType: 'OPTION', // Is option but underlyingSymbol is missing
      underlyingSymbol: null,
      expiryDate: null,
      strikePrice: null,
      optionType: null,
    };

    const result = transactionSchema.safeParse(missingOptionFields);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('标的资产');
    }
  });

  it('should apply conditional checks on FX_CONVERSION trade types', () => {
    const missingFxFields = {
      ledgerId: 1,
      tradeType: 'FX_CONVERSION',
      platform: 'LONGBRIDGE',
      market: 'CASH',
      symbol: 'CNY',
      name: '人民币',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 1,
      quantity: 1000,
      fxFromCurrency: null, // missing currency conversion data
    };

    const result = transactionSchema.safeParse(missingFxFields);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('货币兑换');
    }
  });

  it('should validate ledger schemas', () => {
    const validLedger = {
      name: '夫妻联名账本',
      type: 'JOINT',
      description: '我和老婆的资产记录',
      partners: 'Me,Alice',
    };

    expect(ledgerSchema.safeParse(validLedger).success).toBe(true);

    const invalidLedger = {
      name: '', // Empty name
      type: 'INVALID_TYPE',
    };
    expect(ledgerSchema.safeParse(invalidLedger).success).toBe(false);
  });
});
