import { describe, expect, it } from 'vitest';
import { computeJointContributions, scalePortfolioSnapshot } from '../core/portfolio/jointLedger';

const rates = { usdToCny: 1, hkdToCny: 1 };
const ledger = { id: 9, name: '体验评审-合资', type: 'JOINT', description: '', partners: '我,Alice', createdAt: 1, updatedAt: 1 } as any;
const tx = (tradeType: string, price: number, tradeDate: string, investorName: string | null) => ({
  ledgerId: 9, tradeType, platform: 'SCHWAB', market: 'CASH', symbol: 'CASH', name: '现金', tradeDate, tradeTime: '10:00:00', price, quantity: 1,
  commission: 0, tax: 0, note: '', createdAt: Date.parse(`${tradeDate}T10:00:00Z`), updatedAt: 1, investorName, assetType: 'STOCK',
  underlyingSymbol: null, expiryDate: null, strikePrice: null, optionType: null, fxFromCurrency: null, fxFromAmount: null, fxToCurrency: null, fxToAmount: null, fxRate: null,
}) as any;

describe('joint ledger share accounting', () => {
  it('attributes deposits to partners and defaults missing investor to the first partner', () => {
    const result = computeJointContributions(ledger, [tx('DEPOSIT', 100, '2026-01-01', '我'), tx('DEPOSIT', 300, '2026-01-02', 'Alice')], [], rates);
    expect(result.map((item) => item.ratio)).toEqual([0.25, 0.75]);
    expect(result.map((item) => item.assetsShareCny)).toEqual([100, 300]);
  });

  it('uses equal shares when no contribution units remain', () => {
    const result = computeJointContributions(ledger, [tx('DEPOSIT', 100, '2026-01-01', null), tx('WITHDRAW', 100, '2026-01-02', null)], [], rates);
    expect(result.map((item) => item.ratio)).toEqual([0.5, 0.5]);
  });

  it('scales portfolio money and positions while preserving average cost', () => {
    const snapshot = { totalAssetsCny: 100, holdingsValueCny: 80, cashBalanceCny: 20, totalDepositCny: 100, totalWithdrawCny: 0, netInflowCny: 100, unrealizedProfitCny: 10, unrealizedProfitPercent: 12.5, dayProfitCny: 2, dayProfitPercent: 2, totalCommissionCny: 1, totalTaxCny: 0, securityTradeCount: 2, buyTradeCount: 1, sellTradeCount: 1, positions: { 'US:AAPL': { symbol: 'AAPL', name: 'Apple', market: 'US', quantity: 10, averageCost: 8, remainingCost: 80, realizedProfit: 4, assetType: 'STOCK', underlyingSymbol: null } } } as any;
    const scaled = scalePortfolioSnapshot(snapshot, 0.25);
    expect(scaled.totalAssetsCny).toBe(25);
    expect(scaled.positions['US:AAPL']).toMatchObject({ quantity: 2.5, averageCost: 8, remainingCost: 20, realizedProfit: 1 });
  });
});
