import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpDown, ChevronRight, TrendingDown, TrendingUp } from 'lucide-react';
import { db } from '../db/localDb';
import type { Transaction } from '../db/schema';
import { useAppShell } from '../app/AppShell';
import { PortfolioCalculator } from '../core/portfolio/portfolioCalculator';
import { securityDetailPath } from '../core/portfolio/securityDetailRoute';
import { formatSignedDisplayAmount } from '../core/portfolio/analysisUtils';
import { analysisRuntimeCache, analysisRates, readAnalysisInput, type AnalysisScope } from '../core/portfolio/analysisRuntime';
import { BrokerPlatform, CurrencyType, DisplayCurrency } from '../shared/models';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';

type RankingRange = 'ALL' | 'THIS_MONTH' | 'ONE_MONTH' | 'SIX_MONTHS' | 'THIS_YEAR' | 'CUSTOM';
const calculator = new PortfolioCalculator();
const rangeOptions: Array<[RankingRange, string]> = [
  ['ALL', '全部'], ['THIS_MONTH', '本月'], ['ONE_MONTH', '近1月'],
  ['SIX_MONTHS', '近6月'], ['THIS_YEAR', '今年'], ['CUSTOM', '自定义'],
];
const EMPTY_LIST: never[] = [];
const toDateString = (date: Date) => date.toISOString().slice(0, 10);
const todayString = () => toDateString(new Date());
const previousDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return toDateString(date);
};

function clamp(value: string, min: string, max: string) {
  return value < min ? min : value > max ? max : value;
}

function resolveRange(range: RankingRange, firstDate: string, latestDate: string, customStart: string, customEnd: string) {
  if (range === 'CUSTOM') {
    const start = clamp(customStart || firstDate, firstDate, latestDate);
    const end = clamp(customEnd || latestDate, firstDate, latestDate);
    return start <= end ? { fromDate: start, toDate: end } : { fromDate: end, toDate: start };
  }
  if (range === 'ALL') return { fromDate: firstDate, toDate: latestDate };
  const start = new Date(`${latestDate}T00:00:00Z`);
  if (range === 'THIS_MONTH') start.setUTCDate(1);
  if (range === 'ONE_MONTH') start.setUTCMonth(start.getUTCMonth() - 1);
  if (range === 'SIX_MONTHS') start.setUTCMonth(start.getUTCMonth() - 6);
  if (range === 'THIS_YEAR') start.setUTCMonth(0, 1);
  return { fromDate: clamp(toDateString(start), firstDate, latestDate), toDate: latestDate };
}

function instrumentPnl(
  key: string,
  fromDate: string,
  toDate: string,
  transactions: Transaction[],
  quotes: Awaited<ReturnType<typeof readAnalysisInput>>['quotes'],
  bars: Awaited<ReturnType<typeof readAnalysisInput>>['bars'],
) {
  const [market, symbol] = key.split(':');
  const positionTransactions = transactions.filter((transaction) => `${transaction.market}:${transaction.symbol}` === key);
  if (!positionTransactions.length) return null;
  const opening = calculator.calculate(positionTransactions.filter((transaction) => transaction.tradeDate < fromDate), [], analysisRates).positions[key];
  const closing = calculator.calculate(positionTransactions.filter((transaction) => transaction.tradeDate <= toDate), [], analysisRates).positions[key];
  if (!opening && !closing) return null;
  const quote = quotes.find((item) => item.market === market && item.symbol === symbol);
  const securityBars = bars.filter((bar) => bar.securityKey === key && bar.resolution === '1d').sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
  const priceAt = (date: string, fallback: number, allowCurrent: boolean) => {
    if (allowCurrent && date >= todayString() && quote?.currentPrice != null) return quote.currentPrice;
    return securityBars.filter((bar) => bar.tradeDate <= date).at(-1)?.close ?? fallback;
  };
  const multiplier = PortfolioSecurityRules.optionMultiplier(closing?.assetType ?? opening?.assetType ?? 'STOCK', symbol);
  const openingPrice = priceAt(previousDate(fromDate), opening?.averageCost ?? closing?.averageCost ?? 0, false);
  const closingPrice = priceAt(toDate, closing?.averageCost ?? opening?.averageCost ?? 0, true);
  const openingValue = (opening?.quantity ?? 0) * openingPrice * multiplier;
  const closingValue = (closing?.quantity ?? 0) * closingPrice * multiplier;
  const openingUnrealized = openingValue - (opening?.remainingCost ?? 0);
  const closingUnrealized = closingValue - (closing?.remainingCost ?? 0);
  const realized = (closing?.realizedProfit ?? 0) - (opening?.realizedProfit ?? 0);
  return {
    key,
    market: market as keyof typeof BrokerPlatform | string,
    symbol,
    name: closing?.name || opening?.name || positionTransactions[0]?.name || symbol,
    assetType: closing?.assetType || opening?.assetType || positionTransactions[0]?.assetType || 'STOCK',
    underlyingSymbol: closing?.underlyingSymbol || opening?.underlyingSymbol || positionTransactions[0]?.underlyingSymbol,
    profitCny: (closingUnrealized - openingUnrealized + realized) * (market === 'US' ? analysisRates.usdToCny : market === 'HK' ? analysisRates.hkdToCny : 1),
  };
}

export default function FullRankingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { activePlatform } = useAppShell();
  const [range, setRange] = useState<RankingRange>(() => {
    const candidate = searchParams.get('range') as RankingRange | null;
    return rangeOptions.some(([value]) => value === candidate) ? candidate! : 'THIS_MONTH';
  });
  const [customStart, setCustomStart] = useState(searchParams.get('customStart') || '');
  const [customEnd, setCustomEnd] = useState(searchParams.get('customEnd') || '');
  const [showProfit, setShowProfit] = useState(true);
  const [sortAscending, setSortAscending] = useState(false);
  const activeLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value ?? 1) ?? 1;
  const storedCurrency = useLiveQuery(async () => (await db.appSettings.get('display_currency'))?.value) ?? 'CNY';
  const displayCurrency = DisplayCurrency[storedCurrency as CurrencyType] ?? DisplayCurrency.CNY;
  const scope = useMemo<AnalysisScope>(() => ({ ledgerId: typeof activeLedgerId === 'number' ? activeLedgerId : 1, platform: activePlatform }), [activeLedgerId, activePlatform]);
  const cachedInput = analysisRuntimeCache.peek(scope);
  const input = useLiveQuery(() => readAnalysisInput(scope), [scope.ledgerId, scope.platform], cachedInput?.request);
  const transactions = input?.transactions ?? EMPTY_LIST;
  const quotes = input?.quotes ?? EMPTY_LIST;
  const bars = input?.bars ?? EMPTY_LIST;
  useEffect(() => {
    if (input) analysisRuntimeCache.remember(scope, input);
  }, [input, scope]);
  const firstDate = transactions.length ? [...transactions].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))[0].tradeDate : todayString();
  const rangeBounds = resolveRange(range, firstDate, todayString(), customStart, customEnd);
  const rankingList = useMemo(() => {
    const keys = new Set(transactions.filter((transaction) => transaction.market !== 'CASH' && transaction.symbol !== 'CASH').map((transaction) => `${transaction.market}:${transaction.symbol}`));
    const rows = [...keys].map((key) => instrumentPnl(key, rangeBounds.fromDate, rangeBounds.toDate, transactions, quotes, bars)).filter((row): row is NonNullable<ReturnType<typeof instrumentPnl>> => row !== null && row.market !== 'CASH');
    const filtered = rows.filter((row) => showProfit ? row.profitCny > 0 : row.profitCny < 0);
    return filtered.sort((left, right) => sortAscending ? left.profitCny - right.profitCny : right.profitCny - left.profitCny);
  }, [bars, quotes, rangeBounds.fromDate, rangeBounds.toDate, showProfit, sortAscending, transactions]);

  return <div className="page page-secondary secondary-detail-page full-ranking-page">
    <SecondaryPageHeader title="盈亏排行" fallback="/analysis" />
    <div className="analysis-segment full-ranking-range-selector">{rangeOptions.map(([value, label]) => <button type="button" key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{label}</button>)}</div>
    {range === 'CUSTOM' && <div className="analysis-custom-range"><input type="date" value={customStart || firstDate} min={firstDate} max={todayString()} onChange={(event) => setCustomStart(event.target.value)} /><span>至</span><input type="date" value={customEnd || todayString()} min={firstDate} max={todayString()} onChange={(event) => setCustomEnd(event.target.value)} /></div>}
    <div className="full-ranking-filter-row"><div className="analysis-chip-row"><button type="button" className={showProfit ? 'active' : ''} onClick={() => { setShowProfit(true); setSortAscending(false); }}><TrendingUp size={14} />盈利排行</button><button type="button" className={!showProfit ? 'active' : ''} onClick={() => { setShowProfit(false); setSortAscending(true); }}><TrendingDown size={14} />亏损排行</button></div><button type="button" className="full-ranking-sort" onClick={() => setSortAscending((value) => !value)}><ArrowUpDown size={14} />{sortAscending ? '升序' : '降序'}</button></div>
    <div className="full-ranking-list">{rankingList.length === 0 ? <div className="full-ranking-empty">{showProfit ? '当前区间内没有盈利的股票' : '当前区间内没有亏损的股票'}</div> : rankingList.map((item, index) => <button type="button" className="full-ranking-row" key={item.key} onClick={() => navigate(securityDetailPath(item))}><span className={`full-ranking-index ${index < 3 ? (showProfit ? 'positive' : 'negative') : ''}`}>{index + 1}</span><span className="full-ranking-copy"><strong>{item.name}</strong><small>{item.symbol} · {item.market}</small></span><b className={item.profitCny >= 0 ? 'profit' : 'loss'}>{formatSignedDisplayAmount(item.profitCny, displayCurrency.symbol, displayCurrency.cnyRate)}</b><ChevronRight size={20} /></button>)}</div>
  </div>;
}
