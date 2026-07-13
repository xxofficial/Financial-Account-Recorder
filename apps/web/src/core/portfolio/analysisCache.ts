import type { HistoricalBar, QuoteSnapshot, Transaction } from '../../db/schema';
import type { ExchangeRates } from './portfolioCalculator';
import { buildAnalysisPoints, type AnalysisPoint } from './analysisUtils';

export interface AnalysisDataRequest {
  transactions: Transaction[];
  quotes: QuoteSnapshot[];
  bars: HistoricalBar[];
  rates: ExchangeRates;
}

export type AnalysisExecutor = (request: AnalysisDataRequest) => Promise<AnalysisPoint[]>;

/** Caches both completed and in-flight calculations for one app process. */
export class AnalysisComputationCache {
  private readonly completed = new Map<string, AnalysisPoint[]>();
  private readonly inFlight = new Map<string, Promise<AnalysisPoint[]>>();

  constructor(private readonly execute: AnalysisExecutor) {}

  peek(cacheKey: string): AnalysisPoint[] | undefined {
    return this.completed.get(cacheKey);
  }

  get(cacheKey: string, request: AnalysisDataRequest): Promise<AnalysisPoint[]> {
    const cached = this.completed.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const task = this.execute(request).then((points) => {
      this.completed.set(cacheKey, points);
      return points;
    }).finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, task);
    return task;
  }
}

export function createAnalysisDataVersion(request: Pick<AnalysisDataRequest, 'transactions' | 'quotes' | 'bars'>): string {
  const latest = (values: Array<{ updatedAt?: number; fetchedAt?: number }>) => values.reduce((max, item) => Math.max(max, item.updatedAt ?? item.fetchedAt ?? 0), 0);
  return [
    request.transactions.length, latest(request.transactions),
    request.quotes.length, latest(request.quotes),
    request.bars.length, latest(request.bars),
  ].join(':');
}

class SharedAnalysisWorker {
  private worker: Worker | null = null;
  private nextRequestId = 0;
  private readonly pending = new Map<number, { resolve: (points: AnalysisPoint[]) => void; reject: (reason: Error) => void }>();

  run(request: AnalysisDataRequest): Promise<AnalysisPoint[]> {
    if (typeof Worker === 'undefined') return Promise.resolve(buildAnalysisPoints(request.transactions, request.quotes, request.bars, request.rates));
    if (!this.worker) this.createWorker();
    const requestId = ++this.nextRequestId;
    return new Promise<AnalysisPoint[]>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker!.postMessage({ requestId, ...request });
    });
  }

  private createWorker() {
    this.worker = new Worker(new URL('./analysisWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<{ requestId: number; points: AnalysisPoint[] }>) => {
      const pending = this.pending.get(event.data.requestId);
      if (!pending) return;
      this.pending.delete(event.data.requestId);
      pending.resolve(event.data.points);
    };
    this.worker.onerror = () => {
      const error = new Error('分析数据计算失败，请稍后重试。');
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
      this.worker?.terminate();
      this.worker = null;
    };
  }
}

const sharedWorker = new SharedAnalysisWorker();
export const analysisComputationCache = new AnalysisComputationCache((request) => sharedWorker.run(request));
