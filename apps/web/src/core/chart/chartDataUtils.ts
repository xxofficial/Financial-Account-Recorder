import type { Transaction, HistoricalBar } from '../../db/schema';
import { describeSplitFactor } from '../../shared/splitRatio';

export type ChartBar = {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ChartRange = 'ALL' | 'THIS_MONTH' | 'ONE_MONTH' | 'SIX_MONTHS' | 'THIS_YEAR';

export function formatTimeForChart(tradeDate: string): string {
  return tradeDate; // lightweight-charts 接受 ISO 日期字符串
}

export function getRangeStartDate(range: ChartRange): string {
  const now = new Date();
  let start: Date;

  switch (range) {
    case 'THIS_MONTH':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'ONE_MONTH':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      start.setMonth(start.getMonth() - 1);
      break;
    case 'SIX_MONTHS':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      start.setMonth(start.getMonth() - 6);
      break;
    case 'THIS_YEAR':
      start = new Date(now.getFullYear(), 0, 1);
      break;
    case 'ALL':
    default:
      return '';
  }

  return start.toISOString().split('T')[0];
}

export function filterBarsByRange(bars: ChartBar[], range: ChartRange): ChartBar[] {
  const startDate = getRangeStartDate(range);
  if (!startDate) return [...bars];
  return bars.filter((b) => b.time >= startDate);
}

export function computeMovingAverage(
  data: { time: string; value: number }[],
  period: number
): { time: string; value: number | null }[] {
  if (period <= 0 || data.length === 0) return [];

  const result: { time: string; value: number | null }[] = [];
  let sum = 0;

  for (let i = 0; i < data.length; i++) {
    sum += data[i].value;
    if (i >= period) {
      sum -= data[i - period].value;
    }
    if (i >= period - 1) {
      result.push({ time: data[i].time, value: sum / period });
    } else {
      result.push({ time: data[i].time, value: null });
    }
  }

  return result;
}

export function historicalBarsToChartBars(bars: HistoricalBar[], splitTransactions: Transaction[] = []): ChartBar[] {
  return bars
    .filter((b) => b.resolution === '1d')
    .map((b) => {
      const open = b.open ?? b.close;
      const close = b.close;
      const high = b.high ?? Math.max(open, close);
      const low = b.low ?? Math.min(open, close);
      const splitFactor = splitTransactions
        .filter((transaction) => transaction.tradeType === 'SPLIT' && transaction.tradeDate > b.tradeDate && transaction.price > 0)
        .filter(() => b.adjustmentMode !== 'split_adjusted' && b.adjustedMode !== 'split_adjusted')
        .reduce((factor, transaction) => factor * transaction.price, 1);
      return {
        time: formatTimeForChart(b.tradeDate),
        open: open / splitFactor,
        high: high / splitFactor,
        low: low / splitFactor,
        close: close / splitFactor,
        volume: (b.volume ?? 0) * splitFactor,
      };
    })
    .sort((a, b) => a.time.localeCompare(b.time));
}

export interface TradeMarker {
  time: string;
  position: 'aboveBar' | 'belowBar';
  color: string;
  text: string;
}

export function buildTradeMarkers(
  trades: Transaction[],
  options?: { buyColor?: string; sellColor?: string; splitColor?: string }
): TradeMarker[] {
  const buyColor = options?.buyColor ?? 'var(--color-success)';
  const sellColor = options?.sellColor ?? 'var(--color-error)';
  const splitColor = options?.splitColor ?? '#6366f1';
  const markers: TradeMarker[] = [];

  // 按日期聚合交易
  const byDate = new Map<string, Transaction[]>();
  for (const t of trades) {
    if (t.assetType === 'OPTION') continue;
    if (!t.tradeDate) continue;

    const list = byDate.get(t.tradeDate) ?? [];
    list.push(t);
    byDate.set(t.tradeDate, list);
  }

  for (const [date, dayTrades] of byDate) {
    const splitKeys = new Set<string>();
    for (const transaction of dayTrades.filter((item) => item.tradeType === 'SPLIT')) {
      const display = describeSplitFactor(transaction.price);
      const key = `${date}:${transaction.price}`;
      if (splitKeys.has(key)) continue;
      splitKeys.add(key);
      markers.push({
        time: date,
        position: 'aboveBar',
        color: splitColor,
        text: display.direction === '拆股' ? '拆' : display.direction === '并股' ? '并' : '比',
      });
    }

    const buyQty = dayTrades
      .filter((t) => t.tradeType === 'BUY')
      .reduce((sum, t) => sum + t.quantity, 0);
    const sellQty = dayTrades
      .filter((t) => t.tradeType === 'SELL')
      .reduce((sum, t) => sum + t.quantity, 0);

    if (buyQty > 0) {
      markers.push({
        time: date,
        position: 'belowBar',
        color: buyColor,
        text: 'B',
      });
    }

    if (sellQty > 0) {
      markers.push({
        time: date,
        position: 'aboveBar',
        color: sellColor,
        text: 'S',
      });
    }
  }

  return markers;
}

export type CandlestickColorScheme = 'red_up' | 'green_up';

export function getCandlestickColors(scheme: CandlestickColorScheme) {
  if (scheme === 'green_up') {
    return {
      upColor: '#10b981',
      downColor: '#ef4444',
      upBorderColor: '#10b981',
      downBorderColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    };
  }
  // default red_up (A股/港股习惯：红涨绿跌)
  return {
    upColor: '#ef4444',
    downColor: '#10b981',
    upBorderColor: '#ef4444',
    downBorderColor: '#10b981',
    wickUpColor: '#ef4444',
    wickDownColor: '#10b981',
  };
}

export function getVolumeColor(scheme: CandlestickColorScheme, isUp: boolean): string {
  if (scheme === 'green_up') {
    return isUp ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)';
  }
  return isUp ? 'rgba(239, 68, 68, 0.5)' : 'rgba(16, 185, 129, 0.5)';
}

export const MA_COLORS: Record<string, string> = {
  MA5: '#f59e0b',
  MA10: '#3b82f6',
  MA20: '#8b5cf6',
  MA30: '#06b6d4',
  MA60: '#ec4899',
};

export const MA_PERIODS = [5, 10, 20, 30, 60];
