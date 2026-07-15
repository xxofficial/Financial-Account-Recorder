import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBrokerText, parsePdfStatementText, parseSchwabTransactionsCsv } from '@recoder/core';

const schwabCsvSample = resolve(process.cwd(), '../../samples/Statements/Schwab/Individual_XXX398_Transactions_20260704-041450.csv');
const localIt = existsSync(schwabCsvSample) ? it : it.skip;

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

  it('parses Schwab Transactions CSV special cash actions and uses Android-compatible import times', () => {
    const result = parseSchwabTransactionsCsv([
      '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"',
      '"06/30/2026","Reinvest Shares","QLD","PROSHARES ULTRA QQQ","0.0581","$96.75","","-$5.62"',
      '"06/30/2026","Qualified Dividend","AVGO","BROADCOM INC","","","","$9.75"',
      '"06/30/2026","NRA Tax Adj","AVGO","BROADCOM INC","","","","-$0.98"',
      '"06/29/2026","Margin Interest","","INTEREST 05/28 THRU 06/28","","","","-$77.14"',
      '"06/29/2026","Credit Interest","","SCHWAB1 INT 05/28-06/28","","","","$0.01"',
      '"06/28/2026","ADR Mgmt Fee","NVO","NOVO-NORDISK ADR","","","","-$2.25"',
      '"06/28/2026","Foreign Tax Paid","NVO","NOVO-NORDISK ADR","","","","-$49.30"',
      '"06/27/2026 as of 06/26/2026","Wire Received","","FOREIGN CURRENCY DEPOSIT","","","","$7217.67"',
      '"06/26/2026","Journal","AVGX","Adjustment","-25","","",""',
      '"06/26/2026","Stock Split","SNXX","TRADR 2X LONG SNDK DAILY ETF","140","$28.22","",""',
      '"06/26/2026","Security Transfer","MCD","MCDONALDS CORP","-4","","",""',
    ].join('\n'));
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ tradeType: 'BUY', symbol: 'QLD', quantity: 0.0581, tradeTime: '21:35' }),
      expect.objectContaining({ tradeType: 'DIVIDEND', symbol: 'AVGO', price: 9.75, tax: 0.98, tradeTime: '21:35' }),
      expect.objectContaining({ tradeType: 'INTEREST', symbol: 'INTEREST', name: '融资利息', price: 77.14, tradeTime: '21:35' }),
      expect.objectContaining({ tradeType: 'OTHER', symbol: 'CASH', price: 0.01 }),
      expect.objectContaining({ tradeType: 'OTHER', symbol: 'NVO', price: -2.25 }),
      expect.objectContaining({ tradeType: 'TAX', symbol: 'NVO', price: 49.3 }),
      expect.objectContaining({ tradeType: 'DEPOSIT', symbol: 'CASH', price: 7217.67, tradeDate: '2026-06-27' }),
    ]));
    expect(result.candidates).toHaveLength(7);
    expect(result.warnings.join(' ')).toMatch(/Journal.*Stock Split.*Security Transfer/);
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

  localIt('imports supported special actions from the supplied Schwab Transactions CSV', () => {
    const result = parseSchwabTransactionsCsv(readFileSync(schwabCsvSample, 'utf8'));
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ tradeType: 'DEPOSIT', price: 29500 }),
      expect.objectContaining({ tradeType: 'INTEREST', symbol: 'INTEREST', price: 77.14 }),
      expect.objectContaining({ tradeType: 'OTHER', name: 'SCHWAB1 INT 11/26-12/29', price: 0.01 }),
      expect.objectContaining({ tradeType: 'OTHER', symbol: 'NVO', price: -2.25 }),
      expect.objectContaining({ tradeType: 'TAX', symbol: 'NVO', price: 49.3 }),
    ]));
    expect(result.candidates.every((candidate) => !/Journal|Stock Split|Security Transfer/.test(candidate.rawText))).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Journal.*Stock Split.*Security Transfer/);
  });
});
