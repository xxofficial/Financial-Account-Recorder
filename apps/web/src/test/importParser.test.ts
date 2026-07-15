import { describe, expect, it } from 'vitest';
import { parseBrokerText, parsePdfStatementText, parseSchwabTransactionsCsv } from '@recoder/core';

describe('deterministic text import parsers', () => {
  it('parses a Zhuorui email into an idempotent A-share candidate', () => {
    const result = parseBrokerText(`
      您123456A股账户于2026-07-10 09:31:12成功买入证券
      示例公司 600000 CNY 12.34 100 1234.00 成交
      累计成交金额
      示例公司 600000 CNY 12.34 100 1234.00 已完成 备注
      风险提示
    `);

    expect(result.warnings).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      platform: 'ZHUORUI',
      tradeType: 'BUY',
      market: 'A_SHARE',
      symbol: '600000',
      price: 12.34,
      quantity: 100,
      externalReference: 'ZR-123456-20260710093112-BUY-600000-100-12_34',
    });
  });

  it('parses a Schwab confirmation and keeps its external reference stable', () => {
    const result = parseBrokerText(`
      Schwab eConfirms(TM)
      This email contains your trade confirmation(s)
      account ending in 716
      Symbol:
      AAPL
      Action: Purchase
      Trade Date: 4/1/26
      Security Description:
      APPLE INC
      Total Amount:
      2
      $180.50
      $361.00
      $1.00
      $362.00
    `);

    expect(result.warnings).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      platform: 'SCHWAB',
      sourceChannel: 'SCHWAB_EMAIL',
      tradeType: 'BUY',
      market: 'US',
      symbol: 'AAPL',
      tradeDate: '2026-04-01',
      quantity: 2,
      price: 180.5,
      tax: 1,
      externalReference: 'SW-EMAIL-716-2026-04-01-PURCHASE-AAPL-2-180_5-361',
    });
  });

  it('does not claim to parse unknown or scanned content', () => {
    const result = parseBrokerText('这是一张扫描件，无法复制任何有效结单文字。');
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]).toContain('未识别');
  });

  it('parses Schwab Transactions CSV, pairs NRA tax, and uses Android-compatible import times', () => {
    const result = parseSchwabTransactionsCsv([
      '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
      '"06/30/2026","Reinvest Shares","QLD","PROSHARES ULTRA QQQ","0.0581","$96.75","","-$5.62"',
      '"06/30/2026","Qualified Dividend","AVGO","BROADCOM INC","","","","$9.75"',
      '"06/30/2026","NRA Tax Adj","AVGO","BROADCOM INC","","","","-$0.98"',
      '"06/29/2026","Margin Interest","","INTEREST 05/28 THRU 06/28","","","","-$77.14"',
      '"06/26/2026","Journal","AVGX","Adjustment","25","","",""',
    ].join('\n'));
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ tradeType: 'BUY', symbol: 'QLD', quantity: 0.0581, tradeTime: '21:35' }),
      expect.objectContaining({ tradeType: 'DIVIDEND', symbol: 'AVGO', price: 9.75, tax: 0.98, tradeTime: '21:35' }),
      expect.objectContaining({ tradeType: 'INTEREST', symbol: 'CASH', price: 77.14, tradeTime: '21:35' }),
    ]));
    expect(result.warnings.join(' ')).toContain('Journal');
  });

  it('parses the Schwab transaction-detail row layout used by monthly statements', () => {
    const result = parsePdfStatementText(`
      Schwab One International Account
      Statement Period June 1-30, 2026
      Transaction Details
      Date Category Action Symbol/CUSIP Description Quantity Price/Rate per Share($) Charges/Interest($) Amount($)
      06/17 Sale SNXX TRADR 2X LONG SNDK DAILY ETF (16.0000) 38.9900 0.01 623.83
      Industry Fee $0.01
      Total Transactions
    `);
    expect(result.warnings).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      platform: 'SCHWAB',
      tradeType: 'SELL',
      symbol: 'SNXX',
      tradeDate: '2026-06-17',
      quantity: 16,
      price: 38.99,
      tax: 0.01,
    });
  });
});
