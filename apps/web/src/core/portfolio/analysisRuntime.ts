import type { HistoricalBar, Transaction } from '../../db/schema';
import { db } from '../../db/localDb';
import { PortfolioSecurityRules, type ExchangeRates } from './portfolioCalculator';
import {
  analysisComputationCache,
  createAnalysisDataVersion,
  type AnalysisDataRequest,
} from './analysisCache';
import type { AnalysisPoint } from './analysisUtils';
import type { PlatformType } from '../../shared/models';

export interface AnalysisScope {
  ledgerId: number;
  platform: PlatformType | null;
}

export interface AnalysisRuntimeSnapshot {
  request: AnalysisDataRequest;
  version: string;
  points?: AnalysisPoint[];
}

export const analysisRates: ExchangeRates = { usdToCny: 7.2, hkdToCny: 0.92 };

const scopeKey = ({ ledgerId, platform }: AnalysisScope) => `${ledgerId}:${platform ?? 'ALL'}`;

function securityKeysForTransactions(transactions: Transaction[]): Set<string> {
  const keys = new Set<string>();
  for (const transaction of transactions) {
    if (!transaction.symbol || transaction.market === 'CASH') continue;
    const attributed = PortfolioSecurityRules.attributionSymbol(
      transaction.symbol,
      transaction.assetType,
      transaction.underlyingSymbol,
    );
    for (const symbol of new Set([transaction.symbol, attributed])) {
      keys.add(`${transaction.market}:${symbol}`);
    }
  }
  return keys;
}

/** Reads one consistent, scope-filtered analysis input snapshot. */
export async function readAnalysisInput(scope: AnalysisScope): Promise<AnalysisDataRequest> {
  const transactions = scope.ledgerId === 0
    ? await db.transactions.toArray()
    : await db.transactions.where('ledgerId').equals(scope.ledgerId).toArray();
  const scopedTransactions = scope.platform === null
    ? transactions
    : transactions.filter((transaction) => transaction.platform === scope.platform);
  const securityKeys = securityKeysForTransactions(scopedTransactions);

  const [allQuotes, bars] = await Promise.all([
    db.quoteSnapshots.toArray(),
    securityKeys.size > 0
      ? db.historicalBars.where('securityKey').anyOf([...securityKeys]).toArray()
      : Promise.resolve([] as HistoricalBar[]),
  ]);
  const quotes = allQuotes.filter((quote) => securityKeys.has(`${quote.market}:${quote.symbol}`));
  return { transactions: scopedTransactions, quotes, bars, rates: analysisRates };
}

/** Application-lifetime cache for the input snapshot and its computed points. */
class AnalysisRuntimeCache {
  private readonly snapshots = new Map<string, AnalysisRuntimeSnapshot>();
  private readonly inFlight = new Map<string, Promise<AnalysisRuntimeSnapshot>>();

  peek(scope: AnalysisScope): AnalysisRuntimeSnapshot | undefined {
    return this.snapshots.get(scopeKey(scope));
  }

  remember(scope: AnalysisScope, request: AnalysisDataRequest): AnalysisRuntimeSnapshot {
    const key = scopeKey(scope);
    const version = createAnalysisDataVersion(request);
    const existing = this.snapshots.get(key);
    if (existing?.version === version) return existing;
    const snapshot = {
      request,
      version,
      points: analysisComputationCache.peek(`${key}:${version}`),
    } satisfies AnalysisRuntimeSnapshot;
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  refresh(scope: AnalysisScope): Promise<AnalysisRuntimeSnapshot> {
    const key = scopeKey(scope);
    const running = this.inFlight.get(key);
    if (running) return running;

    const task = readAnalysisInput(scope).then(async (request) => {
      const version = createAnalysisDataVersion(request);
      const cached = this.snapshots.get(key);
      if (cached?.version === version && cached.points) return cached;
      const points = await analysisComputationCache.get(`${key}:${version}`, request);
      const snapshot = { request, version, points } satisfies AnalysisRuntimeSnapshot;
      this.snapshots.set(key, snapshot);
      return snapshot;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  warm(scope: AnalysisScope): void {
    void this.refresh(scope).catch(() => undefined);
  }
}

export const analysisRuntimeCache = new AnalysisRuntimeCache();
