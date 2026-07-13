import type { HistoricalBar, QuoteSnapshot, Transaction } from '../../db/schema';
import type { ExchangeRates } from './portfolioCalculator';
import { buildAnalysisPoints, type AnalysisPoint } from './analysisUtils';

type AnalysisWorkerRequest = {
  requestId: number;
  transactions: Transaction[];
  quotes: QuoteSnapshot[];
  bars: HistoricalBar[];
  rates: ExchangeRates;
};

type AnalysisWorkerResponse = {
  requestId: number;
  points: AnalysisPoint[];
};

// Keep the daily valuation work off the React/UI thread. The application-level
// analysis cache owns one worker and dispatches revision-scoped requests, so a
// route can unmount without cancelling a shared calculation.
const workerScope: Worker = self as unknown as Worker;
workerScope.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { requestId, transactions, quotes, bars, rates } = event.data;
  const response: AnalysisWorkerResponse = {
    requestId,
    points: buildAnalysisPoints(transactions, quotes, bars, rates),
  };
  workerScope.postMessage(response);
};
