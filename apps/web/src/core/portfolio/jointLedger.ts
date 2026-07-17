import type { Ledger, QuoteSnapshot, Transaction } from '../../db/schema';
import { convertToCny, PortfolioCalculator, PortfolioSecurityRules, PortfolioSnapshot, type ExchangeRates } from './portfolioCalculator';

export interface JointContribution {
  name: string;
  ratio: number;
  netContributionCny: number;
  assetsShareCny: number;
  pnlShareCny: number;
}

const calculator = new PortfolioCalculator();

function partnerNames(ledger: Ledger | undefined): string[] {
  return (ledger?.partners ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Mirrors Android's unit-based joint-ledger accounting. Deposits and withdrawals
 * buy/sell units at the portfolio value immediately before the transaction;
 * omitted investors are attributed to the first configured partner.
 */
export function computeJointContributions(
  ledger: Ledger | undefined,
  transactions: Transaction[],
  quotes: QuoteSnapshot[],
  rates: ExchangeRates,
): JointContribution[] {
  const names = partnerNames(ledger);
  if (ledger?.type !== 'JOINT' || names.length === 0) return [];

  const units = new Map(names.map((name) => [name, 0]));
  const net = new Map(names.map((name) => [name, 0]));
  let totalUnits = 0;
  const processed: Transaction[] = [];
  const ordered = [...transactions].sort((left, right) =>
    left.tradeDate.localeCompare(right.tradeDate) || left.tradeTime.localeCompare(right.tradeTime) || left.createdAt - right.createdAt,
  );

  for (const transaction of ordered) {
    if (transaction.tradeType === 'DEPOSIT' || transaction.tradeType === 'WITHDRAW') {
      const before = calculator.calculate(processed, quotes, rates);
      const unitPrice = totalUnits > 0 && before.totalAssetsCny > 0 ? before.totalAssetsCny / totalUnits : 1;
      const amountCny = convertToCny(transaction.price * transaction.quantity * PortfolioSecurityRules.optionMultiplier(transaction.assetType, transaction.symbol), transaction.market, rates);
      const investor = transaction.investorName?.trim() && units.has(transaction.investorName.trim())
        ? transaction.investorName.trim()
        : names[0];
      const deltaUnits = amountCny / unitPrice;
      units.set(investor, (units.get(investor) ?? 0) + (transaction.tradeType === 'DEPOSIT' ? deltaUnits : -deltaUnits));
      net.set(investor, (net.get(investor) ?? 0) + (transaction.tradeType === 'DEPOSIT' ? amountCny : -amountCny));
      totalUnits += transaction.tradeType === 'DEPOSIT' ? deltaUnits : -deltaUnits;
    }
    processed.push(transaction);
  }

  const totalAssetsCny = calculator.calculate(transactions, quotes, rates).totalAssetsCny;
  return names.map((name) => {
    const ratio = totalUnits > 0 ? Math.max(0, (units.get(name) ?? 0) / totalUnits) : 1 / names.length;
    const netContributionCny = net.get(name) ?? 0;
    const assetsShareCny = totalAssetsCny * ratio;
    return { name, ratio, netContributionCny, assetsShareCny, pnlShareCny: assetsShareCny - netContributionCny };
  });
}

export function scalePortfolioSnapshot(snapshot: PortfolioSnapshot, ratio: number): PortfolioSnapshot {
  if (ratio === 1) return snapshot;
  return {
    ...snapshot,
    positions: Object.fromEntries(Object.entries(snapshot.positions).map(([key, position]) => [key, {
      ...position,
      quantity: position.quantity * ratio,
      remainingCost: position.remainingCost * ratio,
      realizedProfit: position.realizedProfit * ratio,
    }])),
    totalAssetsCny: snapshot.totalAssetsCny * ratio,
    holdingsValueCny: snapshot.holdingsValueCny * ratio,
    cashBalanceCny: snapshot.cashBalanceCny * ratio,
    totalDepositCny: snapshot.totalDepositCny * ratio,
    totalWithdrawCny: snapshot.totalWithdrawCny * ratio,
    netInflowCny: snapshot.netInflowCny * ratio,
    unrealizedProfitCny: snapshot.unrealizedProfitCny * ratio,
    dayProfitCny: snapshot.dayProfitCny * ratio,
    totalCommissionCny: snapshot.totalCommissionCny * ratio,
    totalTaxCny: snapshot.totalTaxCny * ratio,
  };
}

export function scaleAnalysisPoint<T extends {
  totalAssetsCny: number;
  netInflowCny: number;
  dailyProfitCny: number;
  cumulativeProfitCny: number;
  dailyCommissionCny: number;
  dailyTaxCny: number;
}>(point: T, ratio: number): T {
  if (ratio === 1) return point;
  return {
    ...point,
    totalAssetsCny: point.totalAssetsCny * ratio,
    netInflowCny: point.netInflowCny * ratio,
    dailyProfitCny: point.dailyProfitCny * ratio,
    cumulativeProfitCny: point.cumulativeProfitCny * ratio,
    dailyCommissionCny: point.dailyCommissionCny * ratio,
    dailyTaxCny: point.dailyTaxCny * ratio,
  };
}
