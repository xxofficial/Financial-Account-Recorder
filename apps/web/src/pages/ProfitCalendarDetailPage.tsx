import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react';
import { db } from '../db/localDb';
import { useAppShell } from '../app/AppShell';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';
import { CurrencyType, DisplayCurrency } from '../shared/models';
import { analysisComputationCache, createAnalysisDataVersion } from '../core/portfolio/analysisCache';
import { analysisRuntimeCache, readAnalysisInput, type AnalysisScope } from '../core/portfolio/analysisRuntime';
import { analysisSecurityCache, buildSecurityRangeStats, type SecurityAnalysis, type SecurityRangeStats } from '../core/portfolio/analysisDetail';
import type { AnalysisPoint } from '../core/portfolio/analysisUtils';

type Mode = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
type Unit = 'AMOUNT' | 'PERCENT';
const modes: Array<[Mode, string]> = [['DAY', '日'], ['WEEK', '周'], ['MONTH', '月'], ['YEAR', '年']];
const units: Array<[Unit, string]> = [['AMOUNT', '￥'], ['PERCENT', '%']];
const empty: never[] = [];
const dayMs = 86_400_000;

const toDate = (value: string) => new Date(`${value}T00:00:00Z`);
const toDateString = (value: Date) => value.toISOString().slice(0, 10);
const today = () => toDateString(new Date());
const clampDate = (value: string, min: string, max: string) => value < min ? min : value > max ? max : value;

function monthDates(value: string): string[] {
  const month = toDate(`${value.slice(0, 7)}-01`);
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  first.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, index) => toDateString(new Date(first.getTime() + index * dayMs)));
}

function rangeFor(mode: Mode, date: string): { start: string; end: string } {
  const current = toDate(date);
  if (mode === 'DAY') return { start: date, end: date };
  if (mode === 'WEEK') {
    const start = new Date(current);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    return { start: toDateString(start), end: toDateString(new Date(start.getTime() + 6 * dayMs)) };
  }
  if (mode === 'MONTH') {
    return { start: `${date.slice(0, 7)}-01`, end: toDateString(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0))) };
  }
  return { start: `${current.getUTCFullYear()}-01-01`, end: `${current.getUTCFullYear()}-12-31` };
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  return Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: maximumFractionDigits, maximumFractionDigits });
}

function formatAmount(valueCny: number, currency: { symbol: string; cnyRate: number }, withSymbol = true) {
  const value = valueCny / currency.cnyRate;
  const sign = value >= 0 ? '+' : '-';
  return `${sign}${withSymbol ? currency.symbol : ''}${formatNumber(value)}`;
}

function formatCalendarValue(valueCny: number, unit: Unit, currency: { symbol: string; cnyRate: number }, netInflowCny: number) {
  if (unit === 'PERCENT') {
    const value = netInflowCny > 0 ? valueCny / netInflowCny * 100 : 0;
    return `${value >= 0 ? '+' : '-'}${formatNumber(value)}%`;
  }
  if (Math.abs(valueCny) < 0.005) return '--';
  return formatAmount(valueCny, currency, false);
}

function aggregatePoints(points: AnalysisPoint[], start: string, end: string) {
  const rows = points.filter((point) => point.date >= start && point.date <= end);
  return rows.reduce((sum, point) => sum + point.dailyProfitCny, 0);
}

function rangeStats(points: AnalysisPoint[], start: string, end: string) {
  const rows = points.filter((point) => point.date >= start && point.date <= end);
  const prior = points.filter((point) => point.date < start).at(-1);
  const total = rows.length ? rows.at(-1)!.cumulativeProfitCny - (prior?.cumulativeProfitCny ?? 0) : 0;
  let returnPercent = 0;
  rows.forEach((point) => { returnPercent = ((1 + returnPercent / 100) * (1 + point.dailyReturnPercent / 100) - 1) * 100; });
  return { total, returnPercent };
}

function securityRows(analyses: SecurityAnalysis[], start: string, end: string, netInflowCny: number): SecurityRangeStats[] {
  return analyses.map((analysis) => buildSecurityRangeStats(analysis, start, end, netInflowCny)).filter((row): row is SecurityRangeStats => row !== null).filter((row) => Math.abs(row.totalProfitCny) > 0.005);
}

export default function ProfitCalendarDetailPage() {
  const { mode: urlMode, date: urlDate } = useParams();
  const navigate = useNavigate();
  const { activePlatform } = useAppShell();
  const initialMode = modes.some(([value]) => value === urlMode) ? urlMode as Mode : 'DAY';
  const initialDate = urlDate && /^\d{4}-\d{2}-\d{2}$/.test(urlDate) ? urlDate : today();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [unit, setUnit] = useState<Unit>('AMOUNT');
  const [sortAscending, setSortAscending] = useState(false);

  useEffect(() => {
    setMode(initialMode);
    setSelectedDate(initialDate);
  }, [initialDate, initialMode]);

  const activeLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value ?? 1) ?? 1;
  const storedCurrency = useLiveQuery(async () => (await db.appSettings.get('display_currency'))?.value) ?? 'CNY';
  const displayCurrency = DisplayCurrency[storedCurrency as CurrencyType] ?? DisplayCurrency.CNY;
  const scope = useMemo<AnalysisScope>(() => ({ ledgerId: typeof activeLedgerId === 'number' ? activeLedgerId : 1, platform: activePlatform }), [activeLedgerId, activePlatform]);
  const cachedInput = analysisRuntimeCache.peek(scope);
  const input = useLiveQuery(() => readAnalysisInput(scope), [scope.ledgerId, scope.platform], cachedInput?.request);
  const transactions = input?.transactions ?? empty;
  const quotes = input?.quotes ?? empty;
  const bars = input?.bars ?? empty;
  const version = useMemo(() => createAnalysisDataVersion({ transactions, quotes, bars }), [bars, quotes, transactions]);
  const cacheKey = `${scope.ledgerId}:${scope.platform ?? 'ALL'}:${version}`;
  const [points, setPoints] = useState<AnalysisPoint[]>(cachedInput?.points ?? []);
  const [analyses, setAnalyses] = useState<SecurityAnalysis[]>(analysisSecurityCache.peek(`${cacheKey}:security`) ?? []);

  useEffect(() => {
    if (!input) return;
    analysisRuntimeCache.remember(scope, input);
    const cachedPoints = analysisComputationCache.peek(cacheKey);
    if (cachedPoints) setPoints(cachedPoints);
    else void analysisComputationCache.get(cacheKey, input).then(setPoints);
    void analysisSecurityCache.get(`${cacheKey}:security`, input, points.at(-1)?.date ?? today()).then(setAnalyses);
  }, [cacheKey, input, points, scope]);

  const sortedDates = useMemo(() => transactions.map((transaction) => transaction.tradeDate).sort(), [transactions]);
  const firstDate = points[0]?.date ?? sortedDates[0] ?? today();
  const latestDate = points.at(-1)?.date ?? sortedDates.at(-1) ?? today();
  const safeDate = clampDate(selectedDate, firstDate, latestDate);
  const currentRange = rangeFor(mode, safeDate);
  const netInflow = points.at(-1)?.netInflowCny ?? 0;
  const stats = rangeStats(points, currentRange.start, currentRange.end);
  const rows = useMemo(() => securityRows(analyses, currentRange.start, currentRange.end, netInflow).sort((left, right) => sortAscending ? left.totalProfitCny - right.totalProfitCny : right.totalProfitCny - left.totalProfitCny), [analyses, currentRange.end, currentRange.start, netInflow, sortAscending]);

  const updateRoute = (nextMode: Mode, nextDate: string) => {
    const safe = clampDate(nextDate, firstDate, latestDate);
    setMode(nextMode);
    setSelectedDate(safe);
    navigate(`/analysis/calendar/${nextMode}/${safe}`, { replace: true });
  };
  const movePeriod = (direction: -1 | 1) => {
    const current = toDate(safeDate);
    if (mode === 'DAY' || mode === 'WEEK') current.setUTCMonth(current.getUTCMonth() + direction);
    else if (mode === 'MONTH') current.setUTCFullYear(current.getUTCFullYear() + direction);
    else current.setUTCFullYear(current.getUTCFullYear() + direction * 6);
    updateRoute(mode, toDateString(current));
  };

  return <div className="page page-secondary secondary-detail-page profit-calendar-detail-page">
    <SecondaryPageHeader title={<DetailCurrencySelector currency={displayCurrency.code} />} fallback="/analysis" />
    <div className="profit-calendar-detail-scroll">
      <section className="profit-calendar-detail-card">
        <div className="profit-calendar-segment-wrap"><div className="analysis-segment">{modes.map(([value, label]) => <button type="button" key={value} className={mode === value ? 'active' : ''} onClick={() => updateRoute(value, safeDate)}>{label}</button>)}</div><div className="analysis-segment profit-calendar-unit-segment">{units.map(([value, label]) => <button type="button" key={value} className={unit === value ? 'active' : ''} onClick={() => setUnit(value)}>{label}</button>)}</div></div>
        <div className="analysis-calendar-nav"><button type="button" aria-label="上一页" onClick={() => movePeriod(-1)}><ChevronLeft /></button><strong>{mode === 'DAY' || mode === 'WEEK' ? `${safeDate.slice(0, 4)}年${Number(safeDate.slice(5, 7))}月` : mode === 'MONTH' ? `${safeDate.slice(0, 4)}年` : `${Number(safeDate.slice(0, 4)) - 5} - ${safeDate.slice(0, 4)}`}</strong><button type="button" aria-label="下一页" onClick={() => movePeriod(1)}><ChevronRight /></button></div>
        <CalendarContent mode={mode} date={safeDate} points={points} unit={unit} currency={displayCurrency} netInflowCny={netInflow} onSelect={(date) => updateRoute(mode, date)} />
      </section>
      <section className="profit-calendar-detail-summary"><div><span>累计收益</span><strong className={stats.total >= 0 ? 'profit' : 'loss'}>{formatAmount(stats.total, displayCurrency)}</strong></div><div><span>收益率</span><strong className={stats.returnPercent >= 0 ? 'profit' : 'loss'}>{stats.returnPercent >= 0 ? '+' : '-'}{formatNumber(stats.returnPercent)}%</strong></div></section>
      <section className="profit-calendar-detail-table"><h2>{rangeTitle(mode, safeDate)} 盈亏明细</h2><div className="profit-calendar-table-scroll"><div className="profit-calendar-table minimum-width"><div className="profit-calendar-table-header"><span>名称 / 代码</span><button type="button" onClick={() => setSortAscending((value) => !value)}>总盈亏 <ArrowUpDown size={14} /></button><span>正股盈亏</span><span>衍生物盈亏</span><span>收益率</span></div>{rows.length === 0 ? <div className="profit-calendar-table-empty">当前范围内暂无标的盈亏明细</div> : rows.map((row) => <button type="button" className="profit-calendar-table-row" key={row.key} onClick={() => navigate(`/analysis/stock/${row.symbol}/${row.market}`)}><span><strong>{row.name || row.symbol}</strong><small>{row.market} {row.symbol}</small></span><b className={row.totalProfitCny >= 0 ? 'profit' : 'loss'}>{formatAmount(row.totalProfitCny, displayCurrency)}</b><b className={row.stockProfitCny >= 0 ? 'profit' : 'loss'}>{formatAmount(row.stockProfitCny, displayCurrency)}</b><b className={row.derivativeProfitCny >= 0 ? 'profit' : 'loss'}>{formatAmount(row.derivativeProfitCny, displayCurrency)}</b><b className={row.returnPercent >= 0 ? 'profit' : 'loss'}>{row.returnPercent >= 0 ? '+' : '-'}{formatNumber(row.returnPercent)}%</b></button>)}</div></div></section>
    </div>
  </div>;
}

function DetailCurrencySelector({ currency }: { currency: CurrencyType }) {
  const [open, setOpen] = useState(false);
  return <div className="portfolio-currency-selector analysis-currency-selector">
    <button type="button" className="portfolio-currency-button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      收益日历（{currency}）<ChevronDown size={18} strokeWidth={2.25} aria-hidden="true" />
    </button>
    {open && <div className="portfolio-currency-menu" role="menu">{Object.values(DisplayCurrency).map((option) => <button type="button" key={option.code} role="menuitem" className={option.code === currency ? 'active' : ''} onClick={() => { void db.appSettings.put({ key: 'display_currency', value: option.code, updatedAt: Date.now() }); setOpen(false); }}>{option.label}（{option.code}）</button>)}</div>}
  </div>;
}

function rangeTitle(mode: Mode, date: string) {
  if (mode === 'DAY') return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  if (mode === 'WEEK') { const range = rangeFor(mode, date); return `${Number(range.start.slice(5, 7))}/${Number(range.start.slice(8, 10))} - ${Number(range.end.slice(5, 7))}/${Number(range.end.slice(8, 10))}`; }
  return mode === 'MONTH' ? `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月` : `${date.slice(0, 4)}年`;
}

function CalendarContent({ mode, date, points, unit, currency, netInflowCny, onSelect }: { mode: Mode; date: string; points: AnalysisPoint[]; unit: Unit; currency: { symbol: string; cnyRate: number }; netInflowCny: number; onSelect: (date: string) => void }) {
  if (mode === 'DAY') {
    const month = date.slice(0, 7);
    const days = monthDates(date);
    return <div className="profit-calendar-day-grid"><div className="profit-calendar-weekdays">{['日', '一', '二', '三', '四', '五', '六'].map((day) => <span key={day}>{day}</span>)}</div><div className="profit-calendar-day-cells">{days.map((cellDate) => { const current = cellDate.startsWith(month); const amount = aggregatePoints(points, cellDate, cellDate); const weekend = [0, 6].includes(toDate(cellDate).getUTCDay()); return <button type="button" key={cellDate} className={`${current ? 'current' : 'outside'} ${amount > 0 ? 'positive' : amount < 0 ? 'negative' : 'neutral'}`} disabled={!current} onClick={() => onSelect(cellDate)}>{current && <><small>{cellDate.slice(-2)}</small>{amount !== 0 ? <b>{formatCalendarValue(amount, unit, currency, netInflowCny)}</b> : weekend ? <em>休市</em> : null}</>}</button>; })}</div></div>;
  }
  if (mode === 'WEEK') {
    const month = toDate(`${date.slice(0, 7)}-01`);
    const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1)); start.setUTCDate(1 - start.getUTCDay());
    const rows = Array.from({ length: 6 }, (_, index) => { const from = toDateString(new Date(start.getTime() + index * 7 * dayMs)); const to = toDateString(new Date(start.getTime() + (index * 7 + 6) * dayMs)); return { from, to, amount: aggregatePoints(points, from, to) }; });
    return <div className="profit-calendar-bucket-grid">{rows.map((row) => <button type="button" key={row.from} onClick={() => onSelect(row.from)}><small>{Number(row.from.slice(5, 7))}/{Number(row.from.slice(8, 10))} - {Number(row.to.slice(5, 7))}/{Number(row.to.slice(8, 10))}</small><b className={row.amount >= 0 ? 'profit' : 'loss'}>{formatCalendarValue(row.amount, unit, currency, netInflowCny)}</b></button>)}</div>;
  }
  if (mode === 'MONTH') {
    const year = Number(date.slice(0, 4));
    return <div className="profit-calendar-bucket-grid month">{Array.from({ length: 12 }, (_, index) => { const from = `${year}-${String(index + 1).padStart(2, '0')}-01`; const to = toDateString(new Date(Date.UTC(year, index + 1, 0))); const amount = aggregatePoints(points, from, to); return <button type="button" key={from} onClick={() => onSelect(from)}><small>{index + 1}月</small><b className={amount >= 0 ? 'profit' : 'loss'}>{formatCalendarValue(amount, unit, currency, netInflowCny)}</b></button>; })}</div>;
  }
  const endYear = Number(date.slice(0, 4));
  return <div className="profit-calendar-bucket-grid year">{Array.from({ length: 6 }, (_, index) => { const year = endYear - 5 + index; const from = `${year}-01-01`; const to = `${year}-12-31`; const amount = aggregatePoints(points, from, to); return <button type="button" key={from} onClick={() => onSelect(from)}><small>{year}年</small><b className={amount >= 0 ? 'profit' : 'loss'}>{formatCalendarValue(amount, unit, currency, netInflowCny)}</b></button>; })}</div>;
}
