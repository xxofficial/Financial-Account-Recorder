import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, XAxis, YAxis } from 'recharts';
import { ChevronDown, ChevronLeft, ChevronRight, Layers, PieChart as PieIcon } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { useAppShell } from '../app/AppShell';
import { PortfolioCalculator, PortfolioSecurityRules } from '../core/portfolio/portfolioCalculator';
import { securityDetailPath } from '../core/portfolio/securityDetailRoute';
import { AnalysisPoint, AnalysisRange, buildAnalysisStats, formatSignedDisplayAmount, resolveAnalysisRange } from '../core/portfolio/analysisUtils';
import { analysisComputationCache, createAnalysisDataVersion } from '../core/portfolio/analysisCache';
import { analysisRates, analysisRuntimeCache, readAnalysisInput, type AnalysisScope } from '../core/portfolio/analysisRuntime';
import { BrokerPlatform, CurrencyType, DisplayCurrency, PlatformType } from '../shared/models';
import { tradingCalendarService } from '../core/market/tradingCalendarService';
import { computeJointContributions, scaleAnalysisPoint } from '../core/portfolio/jointLedger';

const calculator = new PortfolioCalculator();
const rates = analysisRates;
const EMPTY_LIST: never[] = [];
const ranges: { value: AnalysisRange; label: string }[] = [
  { value: 'ALL', label: '全部' }, { value: 'THIS_MONTH', label: '本月' }, { value: 'ONE_MONTH', label: '近1月' },
  { value: 'SIX_MONTHS', label: '近6月' }, { value: 'THIS_YEAR', label: '今年' }, { value: 'CUSTOM', label: '自定义' },
];
type ChartMetric = 'RETURN' | 'ASSET' | 'TRADE_COUNT';
type CalendarMode = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
type CalendarUnit = 'AMOUNT' | 'PERCENT';
const dayMs = 86_400_000;
const toDate = (value: string) => new Date(`${value}T00:00:00Z`);
const toDateString = (value: Date) => value.toISOString().slice(0, 10);
const formatDate = (value: string) => `${value.slice(5, 7)}/${value.slice(8, 10)}`;
const formatRangeDate = (value: string) => `${Number(value.slice(0, 4))}/${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
const sameDateSet = (left: Set<string>, right: Set<string>) => left.size === right.size && [...left].every((date) => right.has(date));
const displayAmount = (valueCny: number, cnyRate: number) => valueCny / cnyRate;
const signed = (valueCny: number, displayCurrency: { symbol: string; cnyRate: number }) => formatSignedDisplayAmount(valueCny, displayCurrency.symbol, displayCurrency.cnyRate);

function MeasuredAnalysisChart({ children }: { children: (size: { width: number; height: number }) => ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 220 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: Math.floor(rect.width), height: Math.max(1, Math.floor(rect.height)) });
    };
    updateSize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="analysis-chart">{size.width > 0 ? children(size) : <div className="analysis-chart-placeholder" role="status">正在加载图表…</div>}</div>;
}
const compactCalendarValue = (value: number, unit: CalendarUnit) => {
  if (Math.abs(value) < .005) return unit === 'AMOUNT' ? '--' : '0%';
  const sign = value >= 0 ? '+' : '-';
  return unit === 'AMOUNT'
    ? `${sign}${Math.abs(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
    : `${sign}${Math.abs(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
};

function MetricCard({ title, value, trend }: { title: string; value: string; trend?: number }) {
  return <div className="analysis-metric-card"><span>{title}</span><strong className={trend === undefined ? '' : trend >= 0 ? 'profit' : 'loss'}>{value}</strong></div>;
}

function Segment<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return <div className="analysis-segment">{options.map((option) => <button key={option.value} className={value === option.value ? 'active' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function AnalysisCurrencySelector({ currency, onSelect }: { currency: CurrencyType; onSelect: (currency: CurrencyType) => void }) {
  const [open, setOpen] = useState(false);
  return <div className="portfolio-currency-selector analysis-currency-selector">
    <button className="portfolio-currency-button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      区间盈亏({currency})<ChevronDown size={18} strokeWidth={2.25} aria-hidden="true" />
    </button>
    {open && <div className="portfolio-currency-menu" role="menu">
      {Object.values(DisplayCurrency).map((option) => <button key={option.code} role="menuitem" className={option.code === currency ? 'active' : ''} onClick={() => { onSelect(option.code); setOpen(false); }}>{option.label}（{option.code}）</button>)}
    </div>}
  </div>;
}

export default function AnalysisPage() {
  const navigate = useNavigate();
  const { activePlatform } = useAppShell();
  const [range, setRange] = useState<AnalysisRange>('THIS_MONTH');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [metric, setMetric] = useState<ChartMetric>('RETURN');
  const [selectedDate, setSelectedDate] = useState('');
  const [calendarMode, setCalendarMode] = useState<CalendarMode>('DAY');
  const [calendarUnit, setCalendarUnit] = useState<CalendarUnit>('AMOUNT');
  const [calendarOffset, setCalendarOffset] = useState(0);
  const [showProfit, setShowProfit] = useState(true);
  const [selectedPartner, setSelectedPartner] = useState<string | null>(null);
  const [analysisPoints, setAnalysisPoints] = useState<AnalysisPoint[]>([]);
  const [analysisLoading, setAnalysisLoading] = useState(true);
  const [analysisError, setAnalysisError] = useState('');
  const [closedCalendarDates, setClosedCalendarDates] = useState<Set<string>>(new Set());
  const activeLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value ?? 1) ?? 1;
  const ledger = useLiveQuery(() => typeof activeLedgerId === 'number' ? db.ledgers.get(activeLedgerId) : undefined, [activeLedgerId]);
  const storedCurrency = useLiveQuery(async () => (await db.appSettings.get('display_currency'))?.value) ?? 'CNY';
  const displayCurrency = DisplayCurrency[storedCurrency as CurrencyType] ?? DisplayCurrency.CNY;
  const analysisScope = useMemo<AnalysisScope>(() => ({
    ledgerId: typeof activeLedgerId === 'number' ? activeLedgerId : 1,
    platform: activePlatform,
  }), [activeLedgerId, activePlatform]);
  const cachedInput = analysisRuntimeCache.peek(analysisScope);
  const analysisInput = useLiveQuery(
    () => readAnalysisInput(analysisScope),
    [analysisScope.ledgerId, analysisScope.platform],
    cachedInput?.request,
  );
  const transactions = analysisInput?.transactions ?? EMPTY_LIST;
  const quotes = analysisInput?.quotes ?? EMPTY_LIST;
  const historicalBars = analysisInput?.bars ?? EMPTY_LIST;
  const contributions = useMemo(() => computeJointContributions(ledger, transactions, quotes, rates), [ledger, quotes, transactions]);
  const activeContribution = contributions.find((item) => item.name === selectedPartner);
  const viewRatio = activeContribution?.ratio ?? 1;
  useEffect(() => {
    if (selectedPartner && !activeContribution) setSelectedPartner(null);
  }, [activeContribution, selectedPartner]);

  useEffect(() => {
    if (analysisInput) analysisRuntimeCache.remember(analysisScope, analysisInput);
  }, [analysisInput, analysisScope]);

  const analysisVersion = useMemo(() => createAnalysisDataVersion({ transactions, quotes, bars: historicalBars }), [historicalBars, quotes, transactions]);
  const analysisCacheKey = `${analysisScope.ledgerId}:${analysisScope.platform ?? 'ALL'}:${analysisVersion}`;

  useEffect(() => {
    let subscribed = true;
    if (!analysisInput) {
      setAnalysisLoading(true);
      return () => { subscribed = false; };
    }
    const cachedPoints = analysisVersion ? analysisComputationCache.peek(analysisCacheKey) : undefined;
    setAnalysisLoading(!cachedPoints);
    setAnalysisError('');
    setAnalysisPoints(cachedPoints ?? []);
    void analysisComputationCache.get(analysisCacheKey, { transactions, quotes, bars: historicalBars, rates })
      .then((points) => { if (subscribed) { setAnalysisPoints(points); setAnalysisLoading(false); } })
      .catch(() => { if (subscribed) { setAnalysisPoints([]); setAnalysisError('分析数据计算失败，请稍后重试。'); setAnalysisLoading(false); } });
    return () => { subscribed = false; };
  }, [analysisCacheKey, analysisInput, analysisVersion, historicalBars, quotes, transactions]);

  const allPoints = analysisPoints;
  const latestDate = allPoints.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const firstDate = allPoints[0]?.date ?? latestDate;
  const [rangeStart, rangeEnd] = resolveAnalysisRange(range, firstDate, latestDate, customStart, customEnd);
  const rangePoints = useMemo(() => allPoints.filter((point) => point.date >= rangeStart && point.date <= rangeEnd), [allPoints, rangeEnd, rangeStart]);
  const viewAllPoints = useMemo(() => allPoints.map((point) => scaleAnalysisPoint(point, viewRatio)), [allPoints, viewRatio]);
  const viewRangePoints = useMemo(() => rangePoints.map((point) => scaleAnalysisPoint(point, viewRatio)), [rangePoints, viewRatio]);
  const stats = useMemo(() => buildAnalysisStats(viewRangePoints), [viewRangePoints]);
  const rangeTransactions = useMemo(() => transactions.filter((transaction) => transaction.tradeDate >= rangeStart && transaction.tradeDate <= rangeEnd && (transaction.tradeType === 'BUY' || transaction.tradeType === 'SELL')), [rangeEnd, rangeStart, transactions]);
  const fees = useMemo(() => rangeTransactions.reduce((total, transaction) => ({ commission: total.commission + transaction.commission * (transaction.market === 'US' ? rates.usdToCny : transaction.market === 'HK' ? rates.hkdToCny : 1), tax: total.tax + transaction.tax * (transaction.market === 'US' ? rates.usdToCny : transaction.market === 'HK' ? rates.hkdToCny : 1) }), { commission: 0, tax: 0 }), [rangeTransactions]);
  const visibleFees = { commission: fees.commission * viewRatio, tax: fees.tax * viewRatio };
  const selectedPoint = viewRangePoints.find((point) => point.date === selectedDate) ?? viewRangePoints.at(-1);
  const chartData = viewRangePoints.map((point) => ({ ...point, label: formatDate(point.date), value: metric === 'RETURN' ? point.cumulativeReturnPercent : metric === 'ASSET' ? point.totalAssetsCny : point.dailyTradeCount }));

  const ranking = useMemo(() => {
    const snapshot = calculator.calculate(transactions.filter((transaction) => transaction.tradeDate <= rangeEnd), quotes, rates);
    return Object.values(snapshot.positions).map((position) => {
      const quote = quotes.find((item) => item.symbol === position.symbol && item.market === position.market);
      const multiplier = PortfolioSecurityRules.optionMultiplier(position.assetType, position.symbol);
      const marketRate = position.market === 'US' ? rates.usdToCny : position.market === 'HK' ? rates.hkdToCny : 1;
      const rangeBar = historicalBars.filter((bar) => bar.securityKey === `${position.market}:${position.symbol}` && bar.resolution === '1d' && bar.tradeDate <= rangeEnd).sort((left, right) => left.tradeDate.localeCompare(right.tradeDate)).at(-1);
      const valuationPrice = rangeBar?.close ?? (rangeEnd >= toDateString(new Date()) ? quote?.currentPrice : undefined) ?? position.averageCost;
      const currentValue = position.quantity * valuationPrice * multiplier * marketRate;
      return { ...position, profit: (currentValue - position.remainingCost * marketRate + position.realizedProfit * marketRate) * viewRatio };
    }).filter((position) => showProfit ? position.profit > 0 : position.profit < 0).sort((left, right) => showProfit ? right.profit - left.profit : left.profit - right.profit).slice(0, 5);
  }, [historicalBars, quotes, rangeEnd, showProfit, transactions, viewRatio]);

  const allocations = useMemo(() => {
    const snapshot = calculator.calculate(transactions, quotes, rates);
    const values = { US: 0, HK: 0, A_SHARE: 0, CASH: Math.max(0, snapshot.cashBalanceCny) };
    Object.values(snapshot.positions).forEach((position) => {
      const quote = quotes.find((item) => item.symbol === position.symbol && item.market === position.market);
      const value = position.quantity * (quote?.currentPrice ?? position.averageCost) * PortfolioSecurityRules.optionMultiplier(position.assetType, position.symbol) * (position.market === 'US' ? rates.usdToCny : position.market === 'HK' ? rates.hkdToCny : 1);
      values[position.market] += Math.max(0, value);
    });
    const marketRows = [{ name: '美股 US', value: values.US, color: '#3b82f6' }, { name: '港股 HK', value: values.HK, color: '#f59e0b' }, { name: 'A股 CN', value: values.A_SHARE, color: '#10b981' }, { name: '现金 CASH', value: values.CASH, color: '#06b6d4' }];
    const marketTotal = marketRows.reduce((total, item) => total + item.value, 0);
    const platforms = [...new Set(transactions.map((transaction) => transaction.platform))].map((platform) => ({ name: BrokerPlatform[platform as PlatformType]?.label ?? platform, value: calculator.calculate(transactions.filter((transaction) => transaction.platform === platform), quotes, rates).totalAssetsCny }));
    const platformTotal = platforms.reduce((total, item) => total + item.value, 0);
    return { markets: marketRows.map((item) => ({ ...item, percent: marketTotal ? item.value / marketTotal * 100 : 0 })).filter((item) => item.percent > .1), platforms: platforms.map((item) => ({ ...item, percent: platformTotal ? item.value / platformTotal * 100 : 0 })).filter((item) => item.percent > .1).sort((a, b) => b.percent - a.percent) };
  }, [quotes, transactions]);

  const calendar = useMemo(() => buildCalendar(viewAllPoints, latestDate, calendarMode, calendarOffset, closedCalendarDates), [calendarMode, calendarOffset, closedCalendarDates, latestDate, viewAllPoints]);
  useEffect(() => {
    if (calendarMode !== 'DAY') return;
    const dates = calendar.cells.map((cell) => cell.date);
    const markets = transactions.map((transaction) => transaction.market);
    let active = true;
    void tradingCalendarService.closedDatesForMarkets(markets, dates).then((dates) => {
      if (active) setClosedCalendarDates((current) => sameDateSet(current, dates) ? current : dates);
    });
    return () => { active = false; };
  }, [calendar.cells, calendarMode, calendarOffset, latestDate, transactions]);
  const currency = displayCurrency.symbol;
  const calendarValue = (point: AnalysisPoint) => compactCalendarValue(calendarUnit === 'AMOUNT' ? point.dailyProfitCny / displayCurrency.cnyRate : point.dailyReturnPercent, calendarUnit);
  const setDisplayCurrency = (nextCurrency: CurrencyType) => void db.appSettings.put({ key: 'display_currency', value: nextCurrency, updatedAt: Date.now() });
  const rankingQuery = new URLSearchParams({ range });
  if (range === 'CUSTOM') {
    if (customStart) rankingQuery.set('customStart', customStart);
    if (customEnd) rankingQuery.set('customEnd', customEnd);
  }

  return <div className="page tab-page analysis-page">
    {contributions.length > 0 && <section className="joint-perspective-card" aria-label="合资账本视角"><span>查看视角</span><div><button type="button" className={!selectedPartner ? 'active' : ''} onClick={() => setSelectedPartner(null)}>整体</button>{contributions.map((item) => <button type="button" className={selectedPartner === item.name ? 'active' : ''} key={item.name} onClick={() => setSelectedPartner(item.name)}>{item.name} {Math.round(item.ratio * 1000) / 10}%</button>)}</div>{activeContribution && <small>{activeContribution.name}：净入金 {signed(activeContribution.netContributionCny, displayCurrency)}，权益 {signed(activeContribution.assetsShareCny, displayCurrency)}，累计盈亏 {signed(activeContribution.pnlShareCny, displayCurrency)}</small>}</section>}
    <Segment options={ranges} value={range} onChange={setRange} />
    {range === 'CUSTOM' && <div className="analysis-custom-range"><input type="date" value={customStart || firstDate} min={firstDate} max={latestDate} onChange={(event) => setCustomStart(event.target.value)} /><span>至</span><input type="date" value={customEnd || latestDate} min={firstDate} max={latestDate} onChange={(event) => setCustomEnd(event.target.value)} /></div>}
    <section className="analysis-summary"><AnalysisCurrencySelector currency={displayCurrency.code} onSelect={setDisplayCurrency} /><strong className={stats.totalProfitCny >= 0 ? 'profit' : 'loss'}>{signed(stats.totalProfitCny, displayCurrency)}</strong><span className={stats.returnPercent >= 0 ? 'profit' : 'loss'}>{stats.returnPercent >= 0 ? '+' : ''}{stats.returnPercent.toFixed(2)}%</span><small>{formatRangeDate(rangeStart)} – {formatRangeDate(rangeEnd)}</small></section>
    {analysisLoading && transactions.length > 0 && <div className="analysis-loading" role="status">正在计算分析数据…</div>}
    {analysisError && <div className="analysis-empty-state">{analysisError}</div>}
    {!analysisLoading && !analysisError && transactions.length === 0 && <div className="analysis-empty-state">暂无交易数据，添加交易记录后将在这里生成分析结果。<div className="empty-state-actions"><button type="button" onClick={() => navigate('/data/imports')}>导入结单</button><button type="button" className="primary" onClick={() => navigate('/transaction/new')}>手动记账</button></div></div>}
    <div className="analysis-metric-grid two"><MetricCard title="日均盈利" value={signed(stats.averageDailyProfitCny, displayCurrency)} trend={stats.averageDailyProfitCny} /><MetricCard title="胜率" value={`${stats.winRate.toFixed(1)}%`} /></div>
    <div className="analysis-metric-grid three"><MetricCard title="佣金/平台费" value={`${currency}${(visibleFees.commission / displayCurrency.cnyRate).toFixed(2)}`} /><MetricCard title="税费" value={`${currency}${(visibleFees.tax / displayCurrency.cnyRate).toFixed(2)}`} /><MetricCard title="交易次数" value={`${rangeTransactions.length} 笔`} /></div>
    <section className="analysis-chart-card"><Segment options={[{ value: 'RETURN', label: '收益率走势' }, { value: 'ASSET', label: '总资产趋势' }, { value: 'TRADE_COUNT', label: '交易次数' }]} value={metric} onChange={setMetric} /><MeasuredAnalysisChart>{({ width, height }) => metric === 'TRADE_COUNT' ? <BarChart width={width} height={height} data={chartData} onClick={(event: any) => { const point = event?.activePayload?.[0]?.payload; if (point?.date) setSelectedDate(point.date); }}><XAxis dataKey="label" fontSize={10} tickLine={false} /><YAxis fontSize={10} tickLine={false} /><Bar dataKey="value" fill="#2563eb" radius={[4, 4, 0, 0]} /></BarChart> : <AreaChart width={width} height={height} data={chartData} onClick={(event: any) => { const point = event?.activePayload?.[0]?.payload; if (point?.date) setSelectedDate(point.date); }}><defs><linearGradient id="analysis-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2563eb" stopOpacity={.24} /><stop offset="95%" stopColor="#2563eb" stopOpacity={0} /></linearGradient></defs><XAxis dataKey="label" fontSize={10} tickLine={false} /><YAxis fontSize={10} tickLine={false} tickFormatter={(value) => metric === 'RETURN' ? `${value.toFixed(0)}%` : `${currency}${Math.round(value / displayCurrency.cnyRate)}`} /><Area type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} fill="url(#analysis-fill)" /></AreaChart>}</MeasuredAnalysisChart>{selectedPoint && <><div className="analysis-point-title">{selectedPoint.date}</div><div className="analysis-metric-grid two"><MetricCard title={metric === 'RETURN' ? '当天收益率' : metric === 'ASSET' ? '当天收益' : '买入/卖出'} value={metric === 'RETURN' ? `${selectedPoint.dailyReturnPercent.toFixed(2)}%` : metric === 'ASSET' ? signed(selectedPoint.dailyProfitCny, displayCurrency) : `${selectedPoint.dailyTradeCount} 笔`} trend={metric === 'RETURN' ? selectedPoint.dailyReturnPercent : selectedPoint.dailyProfitCny} /><MetricCard title={metric === 'RETURN' ? '累计收益率' : metric === 'ASSET' ? '累计收益' : '费用合计'} value={metric === 'RETURN' ? `${selectedPoint.cumulativeReturnPercent.toFixed(2)}%` : metric === 'ASSET' ? signed(selectedPoint.cumulativeProfitCny, displayCurrency) : `${currency}${((selectedPoint.dailyCommissionCny + selectedPoint.dailyTaxCny) / displayCurrency.cnyRate).toFixed(2)}`} trend={metric === 'RETURN' ? selectedPoint.cumulativeReturnPercent : selectedPoint.cumulativeProfitCny} /></div></>}</section>
    <section className="analysis-calendar-card"><h2>收益日历（{calendarUnit === 'AMOUNT' ? displayCurrency.code : '%'}）</h2><div className="analysis-calendar-controls"><Segment options={[{ value: 'DAY', label: '日' }, { value: 'WEEK', label: '周' }, { value: 'MONTH', label: '月' }, { value: 'YEAR', label: '年' }]} value={calendarMode} onChange={(value) => { setCalendarMode(value); setCalendarOffset(0); }} /><Segment options={[{ value: 'AMOUNT', label: '￥' }, { value: 'PERCENT', label: '%' }]} value={calendarUnit} onChange={setCalendarUnit} /></div><div className="analysis-calendar-nav"><button aria-label="上一页" onClick={() => setCalendarOffset((value) => value - 1)}><ChevronLeft /></button><strong>{calendar.title}</strong><button aria-label="下一页" onClick={() => setCalendarOffset((value) => value + 1)}><ChevronRight /></button></div><CalendarGrid calendar={calendar} mode={calendarMode} renderValue={calendarValue} onOpen={(date) => navigate(`/analysis/calendar/${calendarMode}/${date}`)} /></section>
    <section className="analysis-ranking-card"><h2>区间盈亏排行</h2><div className="analysis-chip-row"><button className={showProfit ? 'active' : ''} onClick={() => setShowProfit(true)}>盈利 Top5</button><button className={!showProfit ? 'active' : ''} onClick={() => setShowProfit(false)}>亏损 Top5</button></div>{ranking.length ? <div className="analysis-ranking-list">{ranking.map((item, index) => <button key={`${item.market}:${item.symbol}`} onClick={() => navigate(securityDetailPath(item))}><span>{index + 1}</span><span><strong>{item.name}</strong><small>{item.symbol} · {item.market}</small></span><b className={item.profit >= 0 ? 'profit' : 'loss'}>{signed(item.profit, displayCurrency)}</b><ChevronRight size={18} /></button>)}</div> : <p>{showProfit ? '当前区间内没有盈利的股票' : '当前区间内没有亏损的股票'}</p>}<button className="analysis-full-ranking" onClick={() => navigate(`/analysis/ranking?${rankingQuery.toString()}`)}>查看完整排行 &gt;</button></section>
    {activeLedgerId === 0 && <><section className="analysis-allocation-card"><h2><PieIcon size={17} />资产市场分布</h2><Allocation rows={allocations.markets} displayCurrency={displayCurrency} /></section><section className="analysis-allocation-card"><h2><Layers size={17} />券商平台分布</h2><Allocation rows={allocations.platforms} displayCurrency={displayCurrency} /></section></>}
  </div>;
}

function Allocation({ rows, displayCurrency }: { rows: { name: string; value: number; percent: number; color?: string }[]; displayCurrency: { symbol: string; cnyRate: number } }) {
  if (!rows.length) return <p className="analysis-empty">暂无资产分布数据</p>;
  return <div className="analysis-allocation-list">{rows.map((row) => <div key={row.name}><div><span>{row.name}</span><b>{displayCurrency.symbol}{displayAmount(row.value, displayCurrency.cnyRate).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}（{row.percent.toFixed(1)}%）</b></div><i><em style={{ width: `${row.percent}%`, background: row.color ?? '#2563eb' }} /></i></div>)}</div>;
}

function buildCalendar(points: AnalysisPoint[], latestDate: string, mode: CalendarMode, offset: number, closedDates: Set<string> = new Set()) {
  const latest = toDate(latestDate);
  if (mode === 'DAY') {
    const month = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + offset, 1));
    const start = new Date(month); start.setUTCDate(1 - start.getUTCDay());
    const pointByDate = new Map(points.map((point) => [point.date, point]));
    const cells = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start.getTime() + index * dayMs);
      const dateString = toDateString(date);
      return { date: dateString, point: pointByDate.get(dateString), current: date.getUTCMonth() === month.getUTCMonth(), isWeekend: closedDates.has(dateString) };
    });
    return { title: `${month.getUTCFullYear()}年${month.getUTCMonth() + 1}月`, cells };
  }
  if (mode === 'WEEK') {
    const month = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + offset, 1));
    const cells = Array.from({ length: 5 }, (_, index) => { const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1 + index * 7)); const end = new Date(Math.min(start.getTime() + 6 * dayMs, Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0))); const rows = points.filter((point) => point.date >= toDateString(start) && point.date <= toDateString(end)); return { date: toDateString(start), label: `${start.getUTCMonth() + 1}/${start.getUTCDate()} - ${end.getUTCMonth() + 1}/${end.getUTCDate()}`, point: aggregatePoints(rows) }; });
    return { title: `${month.getUTCFullYear()}年${month.getUTCMonth() + 1}月`, cells };
  }
  if (mode === 'MONTH') { const year = latest.getUTCFullYear() + offset; return { title: `${year}年`, cells: Array.from({ length: 12 }, (_, index) => { const start = `${year}-${String(index + 1).padStart(2, '0')}-01`; return { date: start, label: `${index + 1}月`, point: aggregatePoints(points.filter((point) => point.date.startsWith(`${year}-${String(index + 1).padStart(2, '0')}`))) }; }) }; }
  const endYear = latest.getUTCFullYear() + offset * 6; return { title: `${endYear - 5} - ${endYear}`, cells: Array.from({ length: 6 }, (_, index) => { const year = endYear - 5 + index; return { date: `${year}-01-01`, label: `${year}`, point: aggregatePoints(points.filter((point) => point.date.startsWith(String(year)))) }; }) };
}

function aggregatePoints(points: AnalysisPoint[]): AnalysisPoint | undefined { if (!points.length) return undefined; const last = points.at(-1)!; return { ...last, dailyProfitCny: points.reduce((sum, point) => sum + point.dailyProfitCny, 0), dailyReturnPercent: points.reduce((sum, point) => sum + point.dailyReturnPercent, 0) }; }

function CalendarGrid({ calendar, mode, renderValue, onOpen }: { calendar: ReturnType<typeof buildCalendar>; mode: CalendarMode; renderValue: (point: AnalysisPoint) => string; onOpen: (date: string) => void }) {
  return <div className={`analysis-calendar-grid ${mode.toLowerCase()}`}>
    {mode === 'DAY' && ['日', '一', '二', '三', '四', '五', '六'].map((day) => <span className="weekday" key={day}>{day}</span>)}
    {calendar.cells.map((cell: any) => {
      if (mode === 'DAY' && !cell.current) return <span key={cell.date} className="analysis-calendar-empty" aria-hidden="true" />;
      const hasValue = Boolean(cell.point && Math.abs(cell.point.dailyProfitCny) > .005);
      const closed = mode === 'DAY' && cell.isWeekend && !hasValue;
      const showZero = mode === 'DAY' && cell.date <= toDateString(new Date());
      const tone = hasValue ? cell.point.dailyProfitCny > 0 ? 'profit-cell' : 'loss-cell' : 'neutral-cell';
      return <button key={cell.date} className={`${closed ? 'closed' : ''} ${tone}`} onClick={() => !closed && onOpen(cell.date)} disabled={closed}>
        <small>{cell.label ?? (mode === 'DAY' ? Number(cell.date.slice(-2)) : '')}</small>
        {closed ? <b className="closed-label">休市</b> : hasValue ? <b className={cell.point.dailyProfitCny >= 0 ? 'profit' : 'loss'}>{renderValue(cell.point)}</b> : showZero ? <b className="neutral">0</b> : null}
      </button>;
    })}
  </div>;
}
