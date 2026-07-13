import { HistoricalBar, QuoteSnapshot, Transaction } from '../../db/schema';
import { ExchangeRates, PortfolioCalculator, PortfolioSnapshot } from './portfolioCalculator';

export type AnalysisRange = 'ALL' | 'THIS_MONTH' | 'ONE_MONTH' | 'SIX_MONTHS' | 'THIS_YEAR' | 'CUSTOM';

export interface AnalysisPoint {
  date: string;
  totalAssetsCny: number;
  netInflowCny: number;
  dailyProfitCny: number;
  cumulativeProfitCny: number;
  dailyReturnPercent: number;
  cumulativeReturnPercent: number;
  dailyCommissionCny: number;
  dailyTaxCny: number;
  dailyTradeCount: number;
}

export interface AnalysisStats {
  totalProfitCny: number;
  returnPercent: number;
  averageDailyProfitCny: number;
  winRate: number;
  bestDayProfitCny: number;
  maxDrawdownPercent: number;
}

const dayMs = 86_400_000;
const calculator = new PortfolioCalculator();
const dateString = (date: Date) => date.toISOString().slice(0, 10);

/** Format a CNY-backed amount in the selected display currency. */
export function formatSignedDisplayAmount(valueCny: number, symbol: string, cnyRate: number): string {
  const value = valueCny / cnyRate;
  return `${value >= 0 ? '+' : '-'}${symbol}${Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function resolveAnalysisRange(range: AnalysisRange, firstDate: string, latestDate: string, customStart?: string, customEnd?: string): [string, string] {
  const latest = new Date(`${latestDate}T00:00:00Z`);
  const first = new Date(`${firstDate}T00:00:00Z`);
  let start = new Date(latest);
  if (range === 'ALL') start = first;
  if (range === 'THIS_MONTH') start = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), 1));
  if (range === 'ONE_MONTH') start.setUTCMonth(start.getUTCMonth() - 1);
  if (range === 'SIX_MONTHS') start.setUTCMonth(start.getUTCMonth() - 6);
  if (range === 'THIS_YEAR') start = new Date(Date.UTC(latest.getUTCFullYear(), 0, 1));
  if (range === 'CUSTOM') {
    const requestedStart = customStart ? new Date(`${customStart}T00:00:00Z`) : first;
    const requestedEnd = customEnd ? new Date(`${customEnd}T00:00:00Z`) : latest;
    const safeStart = requestedStart < first ? first : requestedStart > latest ? latest : requestedStart;
    const safeEnd = requestedEnd < safeStart ? safeStart : requestedEnd > latest ? latest : requestedEnd;
    return [dateString(safeStart), dateString(safeEnd)];
  }
  if (start < first) start = first;
  return [dateString(start), latestDate];
}

export function buildAnalysisPoints(transactions: Transaction[], quotes: QuoteSnapshot[], bars: HistoricalBar[], rates: ExchangeRates, latestDate = dateString(new Date())): AnalysisPoint[] {
  if (!transactions.length) return [];
  const firstDate = transactions.reduce((earliest, transaction) => transaction.tradeDate < earliest ? transaction.tradeDate : earliest, latestDate);
  const finalDate = latestDate < firstDate ? firstDate : latestDate;
  const barsBySecurity = new Map<string, HistoricalBar[]>();
  bars.forEach((bar) => {
    if (bar.resolution !== '1d') return;
    const key = bar.securityKey || `${bar.market}:${bar.symbol}`;
    const rows = barsBySecurity.get(key) ?? [];
    rows.push(bar);
    barsBySecurity.set(key, rows);
  });
  barsBySecurity.forEach((rows) => rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)));

  const quoteBySecurity = new Map<string, QuoteSnapshot>();
  for (const quote of quotes) quoteBySecurity.set(`${quote.market}:${quote.symbol}`, quote);
  for (const transaction of transactions) {
    if (!transaction.symbol || transaction.market === 'CASH') continue;
    const key = `${transaction.market}:${transaction.symbol}`;
    if (quoteBySecurity.has(key)) continue;
    // Historical bars can arrive before a standalone realtime snapshot.  A
    // neutral quote lets PortfolioCalculator use the matched daily bar instead
    // of dropping this security from the analysis altogether.
    quoteBySecurity.set(key, {
      id: key,
      symbol: transaction.symbol,
      market: transaction.market,
      name: transaction.name || transaction.symbol,
      assetType: transaction.assetType,
      currentPrice: null,
      previousClose: null,
      change: null,
      changePercent: null,
      currency: transaction.market === 'US' ? 'USD' : transaction.market === 'HK' ? 'HKD' : 'CNY',
      provider: 'historical-cache',
      fetchedAt: 0,
    });
  }
  const relevantQuotes = Array.from(quoteBySecurity.values()).filter((quote) =>
    transactions.some((transaction) => transaction.market === quote.market && transaction.symbol === quote.symbol),
  );
  const barCursorBySecurity = new Map<string, number>();
  const priceBySecurity = new Map<string, number>();
  const transactionsByDate = new Map<string, Transaction[]>();
  for (const transaction of transactions) {
    const rows = transactionsByDate.get(transaction.tradeDate) ?? [];
    rows.push(transaction);
    transactionsByDate.set(transaction.tradeDate, rows);
  }
  const sortedTransactions = [...transactions].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate) || left.tradeTime.localeCompare(right.tradeTime));
  const snapshotTransactions: Transaction[] = [];
  let transactionCursor = 0;
  const result: AnalysisPoint[] = [];
  let previousSnapshot: PortfolioSnapshot | null = null;
  let cumulativeProfit = 0;
  let cumulativeReturn = 0;
  for (let timestamp = Date.parse(`${firstDate}T00:00:00Z`); timestamp <= Date.parse(`${finalDate}T00:00:00Z`); timestamp += dayMs) {
    const date = dateString(new Date(timestamp));
    while (transactionCursor < sortedTransactions.length && sortedTransactions[transactionCursor].tradeDate <= date) {
      snapshotTransactions.push(sortedTransactions[transactionCursor]);
      transactionCursor += 1;
    }
    for (const [securityKey, securityBars] of barsBySecurity) {
      let cursor = barCursorBySecurity.get(securityKey) ?? 0;
      while (cursor < securityBars.length && securityBars[cursor].tradeDate <= date) {
        priceBySecurity.set(securityKey, securityBars[cursor].close);
        cursor += 1;
      }
      barCursorBySecurity.set(securityKey, cursor);
    }
    const historicalQuotes = relevantQuotes.map((quote) => {
      const price = priceBySecurity.get(`${quote.market}:${quote.symbol}`);
      return price === undefined ? { ...quote, currentPrice: null } : { ...quote, currentPrice: price };
    });
    const snapshot = calculator.calculate(snapshotTransactions, historicalQuotes, rates);
    const dailyNetInflow = (snapshot.netInflowCny - (previousSnapshot?.netInflowCny ?? 0));
    const dailyProfit = previousSnapshot ? snapshot.totalAssetsCny - previousSnapshot.totalAssetsCny - dailyNetInflow : 0;
    const dailyReturn = previousSnapshot && Math.abs(previousSnapshot.totalAssetsCny) > 0.0001
      ? dailyProfit / Math.abs(previousSnapshot.totalAssetsCny) * 100
      : 0;
    cumulativeProfit += dailyProfit;
    cumulativeReturn = ((1 + cumulativeReturn / 100) * (1 + dailyReturn / 100) - 1) * 100;
    result.push({
      date,
      totalAssetsCny: snapshot.totalAssetsCny,
      netInflowCny: snapshot.netInflowCny,
      dailyProfitCny: dailyProfit,
      cumulativeProfitCny: cumulativeProfit,
      dailyReturnPercent: dailyReturn,
      cumulativeReturnPercent: cumulativeReturn,
      dailyCommissionCny: snapshot.totalCommissionCny - (previousSnapshot?.totalCommissionCny ?? 0),
      dailyTaxCny: snapshot.totalTaxCny - (previousSnapshot?.totalTaxCny ?? 0),
      dailyTradeCount: (transactionsByDate.get(date) ?? []).filter((transaction) => transaction.tradeType === 'BUY' || transaction.tradeType === 'SELL').length,
    });
    previousSnapshot = snapshot;
  }
  return result;
}

export function buildAnalysisStats(points: AnalysisPoint[]): AnalysisStats {
  if (!points.length) return { totalProfitCny: 0, returnPercent: 0, averageDailyProfitCny: 0, winRate: 0, bestDayProfitCny: 0, maxDrawdownPercent: 0 };
  const totalProfitCny = points.reduce((sum, point) => sum + point.dailyProfitCny, 0);
  const positiveDays = points.filter((point) => point.dailyProfitCny > 0).length;
  let peak = -Infinity;
  let maxDrawdownPercent = 0;
  points.forEach((point) => {
    peak = Math.max(peak, point.cumulativeProfitCny);
    if (peak > 0) maxDrawdownPercent = Math.min(maxDrawdownPercent, (point.cumulativeProfitCny - peak) / peak * 100);
  });
  return {
    totalProfitCny,
    returnPercent: points.at(-1)?.cumulativeReturnPercent ?? 0,
    averageDailyProfitCny: totalProfitCny / points.length,
    winRate: positiveDays / points.length * 100,
    bestDayProfitCny: Math.max(...points.map((point) => point.dailyProfitCny)),
    maxDrawdownPercent,
  };
}
