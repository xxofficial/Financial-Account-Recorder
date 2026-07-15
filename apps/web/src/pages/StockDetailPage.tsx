import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Calendar, FileText, Info, RefreshCw, TrendingUp } from 'lucide-react';
import { db } from '../db/localDb';
import { useAppShell } from '../app/AppShell';
import { PortfolioCalculator, ExchangeRates, PortfolioSecurityRules, convertToCny } from '../core/portfolio/portfolioCalculator';
import { securityDetailName } from '../core/portfolio/securityDetailRoute';
import { DisplayCurrency, TradeTypeLabels } from '../shared/models';
import { type Transaction } from '../db/schema';
import StockChart from '../components/StockChart';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';
import { marketCacheManager } from '../core/market/marketCacheManager';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import { cacheService } from '../core/market/marketDataCacheService';
import { historicalBarsToChartBars, type ChartRange, type CandlestickColorScheme } from '../core/chart/chartDataUtils';

const calculator = new PortfolioCalculator();
const defaultExchangeRates: ExchangeRates = { usdToCny: 7.20, hkdToCny: 0.92 };
const EMPTY_LIST: never[] = [];
const rangeOptions = [
  ['ALL', '全部'], ['THIS_MONTH', '本月'], ['ONE_MONTH', '近1月'],
  ['SIX_MONTHS', '近6月'], ['THIS_YEAR', '本年'], ['CUSTOM', '自定义'],
] as const;

function toDateString(date: Date) { return date.toISOString().slice(0, 10); }
function clampDate(value: string, min: string, max: string) { return value < min ? min : value > max ? max : value; }

function signed(value: number, currency: { symbol: string }) {
  return `${value >= 0 ? '+' : '-'}${currency.symbol}${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function nativeCurrency(market: string) {
  if (market === 'US') return DisplayCurrency.USD;
  if (market === 'HK') return DisplayCurrency.HKD;
  return DisplayCurrency.CNY;
}

function amount(value: number, currency: { symbol: string; cnyRate: number }) {
  return `${currency.symbol}${(value / currency.cnyRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function nativeAmount(value: number, currency: { symbol: string }) {
  return `${currency.symbol}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function txAmount(tx: Transaction, currency: { cnyRate: number }) {
  const multiplier = PortfolioSecurityRules.optionMultiplier(tx.assetType, tx.symbol);
  return convertToCny(Math.abs(tx.price * tx.quantity * multiplier), tx.market, defaultExchangeRates) / currency.cnyRate;
}

export default function StockDetailPage() {
  const { symbol, market } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const targetSymbol = symbol || '';
  const targetMarket = market || 'US';
  const [range, setRange] = useState(searchParams.get('range') || 'ALL');
  const [customStart, setCustomStart] = useState(searchParams.get('customStart') || '');
  const [customEnd, setCustomEnd] = useState(searchParams.get('customEnd') || '');
  const [activeTab, setActiveTab] = useState<'STOCK' | 'OPTION'>('STOCK');
  const [isFetching, setIsFetching] = useState(false);
  const { activePlatform } = useAppShell();

  // Keep the detail page's ledger scope identical to the analysis home page.
  // `default_ledger` is an AppSetting record, not the numeric ledger id itself;
  // `0` is the aggregate scope and must include transactions from every ledger.
  const activeLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value ?? 1) ?? 1;
  const rawTxns = useLiveQuery(async () => (
    activeLedgerId === 0
      ? db.transactions.toArray()
      : db.transactions.where('ledgerId').equals(activeLedgerId as number).toArray()
  ), [activeLedgerId]) ?? EMPTY_LIST;
  const quotes = useLiveQuery(() => db.quoteSnapshots.toArray()) ?? EMPTY_LIST;
  const historicalBars = useLiveQuery(() => db.historicalBars.where('securityKey').equals(`${targetMarket}:${targetSymbol}`).toArray(), [targetMarket, targetSymbol]) ?? EMPTY_LIST;
  const coverage = useLiveQuery(() => db.historicalCoverage.where('securityKey').equals(`${targetMarket}:${targetSymbol}`).toArray(), [targetMarket, targetSymbol]) ?? EMPTY_LIST;
  const colorScheme = useLiveQuery(async () => {
    const setting = await db.appSettings.get('candlestick_color_scheme');
    return (setting?.value === 'green_up' ? 'green_up' : 'red_up') as CandlestickColorScheme;
  }) ?? 'red_up';
  const displayCurrency = nativeCurrency(targetMarket);

  const securityTxns = useMemo(() => rawTxns.filter((tx) => {
    const attrSymbol = PortfolioSecurityRules.attributionSymbol(tx.symbol, tx.assetType, tx.underlyingSymbol);
    return tx.market === targetMarket && attrSymbol.toUpperCase() === targetSymbol.toUpperCase() &&
      (activePlatform === null || tx.platform === activePlatform);
  }), [activePlatform, rawTxns, targetMarket, targetSymbol]);

  const hasStockDisplayName = useMemo(() => {
    const quoteName = quotes.find((quote) => quote.symbol === targetSymbol && quote.market === targetMarket)?.name;
    if (quoteName && quoteName.trim() && quoteName.trim().toUpperCase() !== targetSymbol.toUpperCase()) return true;
    const stockName = securityTxns.find((tx) => tx.assetType !== 'OPTION')?.name;
    return Boolean(stockName?.trim() && stockName.trim().toUpperCase() !== targetSymbol.toUpperCase());
  }, [quotes, securityTxns, targetMarket, targetSymbol]);

  useEffect(() => {
    if (!targetSymbol || targetMarket === 'CASH' || hasStockDisplayName) return;
    // The resolver writes a quote snapshot; useLiveQuery then refreshes the title.
    void cacheService.resolveSecurityName(targetSymbol, targetMarket).catch(() => null);
  }, [hasStockDisplayName, targetMarket, targetSymbol]);

  const securityDateBounds = useMemo(() => {
    const dates = securityTxns.map((tx) => tx.tradeDate).sort();
    const today = toDateString(new Date());
    return { min: dates[0] ?? today, max: dates[dates.length - 1] ?? today };
  }, [securityTxns]);

  const rangeBounds = useMemo(() => {
    const today = toDateString(new Date());
    const firstTrade = securityDateBounds.min;
    if (range === 'CUSTOM') {
      const fromDate = clampDate(customStart || firstTrade, securityDateBounds.min, securityDateBounds.max);
      const toDate = clampDate(customEnd || securityDateBounds.max, securityDateBounds.min, securityDateBounds.max);
      return { fromDate: fromDate <= toDate ? fromDate : toDate, toDate: fromDate <= toDate ? toDate : fromDate };
    }
    const start = new Date();
    if (range === 'THIS_MONTH') start.setDate(1);
    else if (range === 'ONE_MONTH') start.setMonth(start.getMonth() - 1);
    else if (range === 'SIX_MONTHS') start.setMonth(start.getMonth() - 6);
    else if (range === 'THIS_YEAR') start.setMonth(0, 1);
    else return { fromDate: firstTrade, toDate: today };
    return { fromDate: toDateString(start), toDate: today };
  }, [customEnd, customStart, range, securityDateBounds]);

  const stats = useMemo(() => {
    const inRange = securityTxns.filter((tx) => tx.tradeDate >= rangeBounds.fromDate && tx.tradeDate <= rangeBounds.toDate);
    const stockTxns = securityTxns.filter((tx) => tx.assetType !== 'OPTION');
    const optionTxns = securityTxns.filter((tx) => tx.assetType === 'OPTION');
    const stockRange = inRange.filter((tx) => tx.assetType !== 'OPTION');
    const optionRange = inRange.filter((tx) => tx.assetType === 'OPTION');
    const stockBefore = calculator.calculate(stockTxns.filter((tx) => tx.tradeDate < rangeBounds.fromDate), [], defaultExchangeRates).positions[`${targetMarket}:${targetSymbol}`];
    const stockAfter = calculator.calculate(stockTxns.filter((tx) => tx.tradeDate <= rangeBounds.toDate), [], defaultExchangeRates).positions[`${targetMarket}:${targetSymbol}`];
    const bars = historicalBars.filter((bar) => bar.resolution === '1d' && bar.securityKey === `${targetMarket}:${targetSymbol}`).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    const quote = quotes.find((item) => item.symbol === targetSymbol && item.market === targetMarket);
    const lastTradePrice = (rows: typeof stockTxns, before: string, fallback: number) => rows.filter((tx) => tx.tradeDate <= before && (tx.tradeType === 'BUY' || tx.tradeType === 'SELL')).sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))[0]?.price ?? fallback;
    const priceAt = (date: string, isEnd: boolean, fallback: number) => {
      if (isEnd && date >= toDateString(new Date()) && quote?.currentPrice != null) return quote.currentPrice;
      return bars.filter((bar) => bar.tradeDate <= date).at(-1)?.close ?? lastTradePrice(stockTxns, date, fallback);
    };
    const startPrice = priceAt(rangeBounds.fromDate, false, stockBefore?.averageCost ?? 0);
    const endPrice = priceAt(rangeBounds.toDate, true, stockAfter?.averageCost ?? startPrice);
    const stockOpeningValue = (stockBefore?.quantity ?? 0) * startPrice;
    const stockClosingValue = (stockAfter?.quantity ?? 0) * endPrice;
    const stockBuy = stockRange.filter((tx) => tx.tradeType === 'BUY').reduce((sum, tx) => sum + tx.price * tx.quantity, 0);
    const stockSell = stockRange.filter((tx) => tx.tradeType === 'SELL').reduce((sum, tx) => sum + tx.price * tx.quantity, 0);
    const stockFees = stockRange.reduce((sum, tx) => sum + Math.abs(tx.commission + tx.tax), 0);
    const stockPnl = stockClosingValue - stockOpeningValue + stockSell - stockBuy - stockFees;
    let optionOpeningValue = 0;
    let optionClosingValue = 0;
    let optionBuy = 0;
    let optionSell = 0;
    let optionFees = 0;
    optionTxns.forEach((tx) => {
      const history = optionTxns.filter((row) => row.symbol === tx.symbol);
      if (history[0]?.id !== tx.id) return;
      const before = calculator.calculate(history.filter((row) => row.tradeDate < rangeBounds.fromDate), [], defaultExchangeRates).positions[`${targetMarket}:${tx.symbol}`];
      const after = calculator.calculate(history.filter((row) => row.tradeDate <= rangeBounds.toDate), [], defaultExchangeRates).positions[`${targetMarket}:${tx.symbol}`];
      const optionBars = historicalBars.filter((bar) => bar.resolution === '1d' && bar.securityKey === `${targetMarket}:${tx.symbol}`).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
      const optionQuote = quotes.find((item) => item.symbol === tx.symbol && item.market === targetMarket);
      const fallback = after?.averageCost ?? before?.averageCost ?? 0;
      const endOptionPrice = rangeBounds.toDate >= toDateString(new Date()) && optionQuote?.currentPrice != null ? optionQuote.currentPrice : optionBars.filter((bar) => bar.tradeDate <= rangeBounds.toDate).at(-1)?.close ?? fallback;
      const startOptionPrice = optionBars.filter((bar) => bar.tradeDate < rangeBounds.fromDate).at(-1)?.close ?? before?.averageCost ?? endOptionPrice;
      optionOpeningValue += (before?.quantity ?? 0) * startOptionPrice * 100;
      optionClosingValue += (after?.quantity ?? 0) * endOptionPrice * 100;
      const rows = optionRange.filter((row) => row.symbol === tx.symbol);
      optionBuy += rows.filter((row) => row.tradeType === 'BUY').reduce((sum, row) => sum + row.price * row.quantity * 100, 0);
      optionSell += rows.filter((row) => row.tradeType === 'SELL').reduce((sum, row) => sum + row.price * row.quantity * 100, 0);
      optionFees += rows.reduce((sum, row) => sum + Math.abs(row.commission + row.tax), 0);
    });
    const optionPnl = optionClosingValue - optionOpeningValue + optionSell - optionBuy - optionFees;
    const currentTxns = activeTab === 'OPTION' ? optionRange : stockRange;
    const closingValue = activeTab === 'OPTION' ? optionClosingValue : stockClosingValue;
    const buyCost = activeTab === 'OPTION' ? optionBuy : stockBuy;
    const sellProceeds = activeTab === 'OPTION' ? optionSell : stockSell;
    const fees = activeTab === 'OPTION' ? optionFees : stockFees;
    const sorted = [...currentTxns].sort((a, b) => `${b.tradeDate} ${b.tradeTime}`.localeCompare(`${a.tradeDate} ${a.tradeTime}`));
    const titleQuote = quotes.find((quote) => quote.symbol === targetSymbol && quote.market === targetMarket);
    return {
      securityName: securityDetailName(targetSymbol, titleQuote?.name, stockTxns[0]?.name),
      stockPnl, optionPnl, totalPnl: stockPnl + optionPnl,
      buyCost, sellProceeds, fees, closingValue, stockOpeningValue, optionOpeningValue,
      totalQuantity: activeTab === 'OPTION' ? optionRange.reduce((sum, tx) => sum + (tx.tradeType === 'BUY' ? tx.quantity : tx.tradeType === 'SELL' ? -tx.quantity : 0), 0) : (stockAfter?.quantity ?? 0),
      currentPrice: titleQuote?.currentPrice ?? endPrice, txnsList: sorted, hasOptions: optionTxns.length > 0,
    };
  }, [activeTab, historicalBars, quotes, rangeBounds.fromDate, rangeBounds.toDate, securityTxns, targetMarket, targetSymbol]);

  const { chartBars, stockTrades, hasChartData } = useMemo(() => {
    const bars = historicalBars.filter((bar) => bar.resolution === '1d');
    const filteredBars = bars.filter((bar) => bar.tradeDate >= rangeBounds.fromDate && bar.tradeDate <= rangeBounds.toDate);
    const stockTrades = securityTxns.filter((tx) => tx.assetType !== 'OPTION' && tx.tradeDate >= rangeBounds.fromDate && tx.tradeDate <= rangeBounds.toDate);
    return { chartBars: historicalBarsToChartBars(filteredBars), stockTrades, hasChartData: filteredBars.length > 0 };
  }, [historicalBars, rangeBounds.fromDate, rangeBounds.toDate, securityTxns]);

  const handleFetchMarketData = async () => {
    setIsFetching(true);
    try {
      await marketCacheManager.queueHistoricalRangeForSecurity(targetSymbol, targetMarket, 'stock', rangeBounds);
      await MarketTaskExecutor.startOrWakeMarketExecutor();
    } catch (error: any) {
      alert(`获取行情失败: ${error?.message || error}`);
    } finally { setIsFetching(false); }
  };

  const rangeCoverage = coverage.find((item) => item.resolution === '1d' && item.fromDate <= rangeBounds.fromDate && item.toDate >= rangeBounds.toDate);
  const needsKlineFill = activeTab === 'STOCK' && (!rangeCoverage || rangeCoverage.coverageStatus !== 'complete' || !hasChartData);
  const hasAnyKline = historicalBars.some((bar) => bar.resolution === '1d');
  const isProfit = stats.totalPnl >= 0;
  const selectedPnl = activeTab === 'STOCK' ? stats.stockPnl : stats.optionPnl;

  return <div className="page page-secondary stock-detail-page">
    <SecondaryPageHeader title={<span className="secondary-page-title-stack"><span>{stats.securityName} ({targetSymbol}.{targetMarket})</span><small>包含正股及全部关联期权交易</small></span>} fallback="/analysis" />
    <div className="range-selector stock-detail-range-selector">
      {rangeOptions.map(([value, label]) => <button key={value} type="button" className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{label}</button>)}
    </div>
    {range === 'CUSTOM' && <div className="stock-detail-custom-range"><label>开始<input type="date" min={securityDateBounds.min} max={securityDateBounds.max} value={customStart || securityDateBounds.min} onChange={(event) => setCustomStart(event.target.value)} /></label><span>至</span><label>结束<input type="date" min={securityDateBounds.min} max={securityDateBounds.max} value={customEnd || securityDateBounds.max} onChange={(event) => setCustomEnd(event.target.value)} /></label></div>}

    {activeTab === 'STOCK' && <section className="stock-detail-card stock-detail-kline-card">
      <div className="stock-detail-card-title"><TrendingUp size={16} /><span>日 K 线走势</span></div>
      {hasChartData ? <StockChart bars={chartBars} trades={stockTrades} timeRange={range === 'CUSTOM' ? 'ALL' : range as ChartRange} colorScheme={colorScheme} height={300} /> : <div className="stock-detail-kline-empty">暂无该范围内的日 K 线数据<br /><span>请确保已配置行情 API，然后按需补齐当前范围。</span><button type="button" className="primary" onClick={handleFetchMarketData} disabled={isFetching}>{isFetching && <RefreshCw size={14} className="spin" />}{hasAnyKline ? '补齐日 K 线' : '获取行情'}</button></div>}
      {needsKlineFill && hasChartData && <div className="stock-detail-kline-fill"><span>当前时间范围内日 K 线不完整，可按需补齐。</span><button type="button" className="primary" onClick={handleFetchMarketData} disabled={isFetching}>{isFetching && <RefreshCw size={14} className="spin" />}补齐日 K 线</button></div>}
    </section>}

    <section className="stock-detail-card stock-detail-pnl-card"><div className="stock-detail-card-title"><span>累计盈亏</span><span className="stock-detail-card-helper">{rangeBounds.fromDate} – {rangeBounds.toDate}</span></div><div className="stock-detail-pnl-label">累计盈亏 ({displayCurrency.code})</div><strong className={isProfit ? 'profit' : 'loss'}>{signed(stats.totalPnl, displayCurrency)}</strong><div className="stock-detail-split"><span>正股 <b className={stats.stockPnl >= 0 ? 'profit' : 'loss'}>{signed(stats.stockPnl, displayCurrency)}</b></span><span>衍生品 <b className={stats.optionPnl >= 0 ? 'profit' : 'loss'}>{signed(stats.optionPnl, displayCurrency)}</b></span></div></section>

    {stats.hasOptions && <div className="stock-detail-tabs"><button type="button" className={activeTab === 'STOCK' ? 'active' : ''} onClick={() => setActiveTab('STOCK')}>正股</button><button type="button" className={activeTab === 'OPTION' ? 'active' : ''} onClick={() => setActiveTab('OPTION')}>衍生品</button></div>}

    <section className="stock-detail-card stock-detail-breakdown-card"><div className="stock-detail-card-title"><Info size={16} /><span>盈亏构成</span></div><div className="stock-detail-lines"><div className="stock-detail-line"><span>持仓市值</span><b>{nativeAmount(stats.closingValue, displayCurrency)}</b></div><div className="stock-detail-line"><span>累计入账金额<small>股票/期权卖出</small></span><b className="profit">{nativeAmount(stats.sellProceeds, displayCurrency)}</b></div><div className="stock-detail-line"><span>累计出账金额<small>股票/期权买入</small></span><b className="loss">-{nativeAmount(stats.buyCost, displayCurrency)}</b></div><div className="stock-detail-line"><span>费用合计<small>佣金及税费</small></span><b className="loss">-{nativeAmount(stats.fees, displayCurrency)}</b></div><div className="stock-detail-divider" /><div className="stock-detail-line stock-detail-total"><span>盈亏合计</span><b className={selectedPnl >= 0 ? 'profit' : 'loss'}>{signed(selectedPnl, displayCurrency)}</b></div></div><p className="stock-detail-formula">盈亏合计 = 持仓市值 + 累计入账金额 − 累计出账金额 − 费用</p></section>

    <section className="stock-detail-card stock-detail-transactions-card"><div className="stock-detail-card-title"><FileText size={16} /><span>流水明细</span><small>共 {stats.txnsList.length} 笔</small></div>{stats.txnsList.length === 0 ? <div className="stock-detail-empty">当前区间内没有交易记录</div> : <div className="stock-detail-transactions">{stats.txnsList.map((tx) => { const isBuy = tx.tradeType === 'BUY' || tx.tradeType === 'DEPOSIT' || tx.tradeType === 'TRANSFER_IN'; const value = txAmount(tx, displayCurrency); return <button type="button" className="stock-detail-transaction" key={tx.id} onClick={() => navigate(`/transactions/${tx.id}`)}><div><span className={`badge ${isBuy ? 'success' : 'error'}`}>{TradeTypeLabels[tx.tradeType] || tx.tradeType}</span><b>{tx.quantity} {tx.assetType === 'OPTION' ? '张' : '股'} @ {amount(convertToCny(tx.price, tx.market, defaultExchangeRates), displayCurrency)}</b></div><strong className={isBuy ? 'loss' : 'profit'}>{isBuy ? '-' : '+'}{displayCurrency.symbol}{value.toFixed(2)}</strong><small><Calendar size={12} />{tx.tradeDate} {tx.tradeTime} <span>费用 {amount(convertToCny(tx.commission + tx.tax, tx.market, defaultExchangeRates), displayCurrency)}</span></small></button>; })}</div>}</section>
  </div>;
}
