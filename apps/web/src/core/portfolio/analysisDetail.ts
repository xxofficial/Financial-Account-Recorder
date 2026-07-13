import type { AnalysisDataRequest } from './analysisCache';
import { buildAnalysisPoints, type AnalysisPoint } from './analysisUtils';
import { PortfolioSecurityRules } from './portfolioCalculator';

export interface SecurityAnalysisPoint {
  date: string;
  dailyProfitCny: number;
  cumulativeProfitCny: number;
  cumulativeStockProfitCny: number;
  cumulativeDerivativeProfitCny: number;
}

export interface SecurityAnalysis {
  key: string;
  symbol: string;
  name: string;
  market: string;
  assetType: string;
  underlyingSymbol?: string | null;
  dailyPoints: SecurityAnalysisPoint[];
}

const isDerivative = (transaction: AnalysisDataRequest['transactions'][number]) =>
  PortfolioSecurityRules.isOptionAsset(transaction.assetType, transaction.symbol);

function carryForward(points: AnalysisPoint[], date: string): number {
  return points.filter((point) => point.date <= date).at(-1)?.cumulativeProfitCny ?? 0;
}

function buildSecurityPoints(
  allPoints: AnalysisPoint[],
  stockPoints: AnalysisPoint[],
  derivativePoints: AnalysisPoint[],
): SecurityAnalysisPoint[] {
  return allPoints.map((point) => ({
    date: point.date,
    dailyProfitCny: point.dailyProfitCny,
    cumulativeProfitCny: point.cumulativeProfitCny,
    cumulativeStockProfitCny: carryForward(stockPoints, point.date),
    cumulativeDerivativeProfitCny: carryForward(derivativePoints, point.date),
  }));
}

export function buildSecurityAnalyses(request: AnalysisDataRequest, latestDate?: string): SecurityAnalysis[] {
  const groups = new Map<string, AnalysisDataRequest['transactions']>();
  for (const transaction of request.transactions) {
    if (!transaction.symbol || transaction.market === 'CASH') continue;
    const symbol = PortfolioSecurityRules.attributionSymbol(
      transaction.symbol,
      transaction.assetType,
      transaction.underlyingSymbol,
    );
    const key = `${transaction.market}:${symbol}`;
    const rows = groups.get(key) ?? [];
    rows.push(transaction);
    groups.set(key, rows);
  }

  return [...groups.entries()].map(([key, transactions]) => {
    const allPoints = buildAnalysisPoints(request.transactions.filter((transaction) => {
      const attributed = PortfolioSecurityRules.attributionSymbol(transaction.symbol, transaction.assetType, transaction.underlyingSymbol);
      return transaction.market !== 'CASH' && `${transaction.market}:${attributed}` === key;
    }), request.quotes, request.bars, request.rates, latestDate);
    const stockPoints = buildAnalysisPoints(transactions.filter((transaction) => !isDerivative(transaction)), request.quotes, request.bars, request.rates, latestDate);
    const derivativePoints = buildAnalysisPoints(transactions.filter(isDerivative), request.quotes, request.bars, request.rates, latestDate);
    const first = transactions[0];
    return {
      key,
      symbol: PortfolioSecurityRules.attributionSymbol(first.symbol, first.assetType, first.underlyingSymbol),
      name: first.name || first.symbol,
      market: first.market,
      assetType: first.assetType,
      underlyingSymbol: first.underlyingSymbol,
      dailyPoints: buildSecurityPoints(allPoints, stockPoints, derivativePoints),
    } satisfies SecurityAnalysis;
  }).filter((analysis) => analysis.dailyPoints.length > 0);
}

export interface SecurityRangeStats {
  key: string;
  symbol: string;
  name: string;
  market: string;
  totalProfitCny: number;
  stockProfitCny: number;
  derivativeProfitCny: number;
  returnPercent: number;
}

export function buildSecurityRangeStats(
  analysis: SecurityAnalysis,
  rangeStart: string,
  rangeEnd: string,
  netInflowCny: number,
): SecurityRangeStats | null {
  const points = analysis.dailyPoints.filter((point) => point.date >= rangeStart && point.date <= rangeEnd);
  if (!points.length) return null;
  const prior = analysis.dailyPoints.filter((point) => point.date < rangeStart).at(-1);
  const total = points.at(-1)!.cumulativeProfitCny - (prior?.cumulativeProfitCny ?? 0);
  const stock = points.at(-1)!.cumulativeStockProfitCny - (prior?.cumulativeStockProfitCny ?? 0);
  const derivative = points.at(-1)!.cumulativeDerivativeProfitCny - (prior?.cumulativeDerivativeProfitCny ?? 0);
  return {
    key: analysis.key,
    symbol: analysis.symbol,
    name: analysis.name,
    market: analysis.market,
    totalProfitCny: total,
    stockProfitCny: stock,
    derivativeProfitCny: derivative,
    returnPercent: netInflowCny > 0 ? total / netInflowCny * 100 : 0,
  };
}

export class AnalysisSecurityCache {
  private readonly completed = new Map<string, SecurityAnalysis[]>();
  private readonly inFlight = new Map<string, Promise<SecurityAnalysis[]>>();

  peek(key: string) {
    return this.completed.get(key);
  }

  get(key: string, request: AnalysisDataRequest, latestDate?: string): Promise<SecurityAnalysis[]> {
    const cached = this.completed.get(key);
    if (cached) return Promise.resolve(cached);
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = Promise.resolve().then(() => buildSecurityAnalyses(request, latestDate)).then((result) => {
      this.completed.set(key, result);
      return result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }
}

export const analysisSecurityCache = new AnalysisSecurityCache();
