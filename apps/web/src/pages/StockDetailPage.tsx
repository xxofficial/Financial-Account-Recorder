import { useState, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Calendar, FileText, Info, RefreshCw, TrendingUp } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { PortfolioCalculator, ExchangeRates, PortfolioSecurityRules } from '../core/portfolio/portfolioCalculator';
import { TradeTypeLabels } from '../shared/models';
import StockChart from '../components/StockChart';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';
import { marketCacheManager } from '../core/market/marketCacheManager';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import { historicalBarsToChartBars, type ChartRange, type CandlestickColorScheme } from '../core/chart/chartDataUtils';

const calculator = new PortfolioCalculator();
const defaultExchangeRates: ExchangeRates = {
  usdToCny: 7.20,
  hkdToCny: 0.92,
};
const EMPTY_LIST: never[] = [];

export default function StockDetailPage() {
  const { symbol, market } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const targetSymbol = symbol || '';
  const targetMarket = market || 'US';

  const [range, setRange] = useState(searchParams.get('range') || 'ALL');
  const [activeTab, setActiveTab] = useState<'STOCK' | 'OPTION'>('STOCK');
  const [isFetching, setIsFetching] = useState(false);

  // Reactive DB query
  const activeLedgerId = useLiveQuery(async () => {
    const setting = await db.appSettings.get('default_ledger');
    return typeof setting === 'number' ? setting : 1;
  }) ?? 1;

  const rawTxns = useLiveQuery(() => 
    db.transactions.where('ledgerId').equals(activeLedgerId).toArray(),
    [activeLedgerId]
  ) ?? EMPTY_LIST;

  const quotes = useLiveQuery(() => db.quoteSnapshots.toArray()) ?? EMPTY_LIST;

  const historicalBars = useLiveQuery(() =>
    db.historicalBars.where('securityKey').equals(`${targetMarket}:${targetSymbol}`).toArray(),
    [targetMarket, targetSymbol]
  ) ?? EMPTY_LIST;

  const coverage = useLiveQuery(() =>
    db.historicalCoverage.where('securityKey').equals(`${targetMarket}:${targetSymbol}`).toArray(),
    [targetMarket, targetSymbol]
  ) ?? EMPTY_LIST;

  const colorScheme = useLiveQuery(async () => {
    const setting = await db.appSettings.get('candlestick_color_scheme');
    return (setting?.value === 'green_up' ? 'green_up' : 'red_up') as CandlestickColorScheme;
  }) ?? 'red_up';

  const rangeBounds = useMemo(() => {
    const today = new Date();
    const endDate = today.toISOString().slice(0, 10);
    const start = new Date(today);
    if (range === 'THIS_MONTH') start.setDate(1);
    else if (range === 'ONE_MONTH') start.setMonth(start.getMonth() - 1);
    else if (range === 'SIX_MONTHS') start.setMonth(start.getMonth() - 6);
    else if (range === 'THIS_YEAR') start.setMonth(0, 1);
    else {
      const firstTrade = rawTxns.filter((t) => t.market === targetMarket && PortfolioSecurityRules.attributionSymbol(t.symbol, t.assetType, t.underlyingSymbol).toUpperCase() === targetSymbol.toUpperCase()).map((t) => t.tradeDate).sort()[0];
      return { fromDate: firstTrade ?? endDate, toDate: endDate };
    }
    return { fromDate: start.toISOString().slice(0, 10), toDate: endDate };
  }, [range, rawTxns, targetMarket, targetSymbol]);

  // Group and calculate statistics
  const stats = useMemo(() => {
    // 1. Filter all transactions belonging to this security (including its options)
    const securityTxns = rawTxns.filter(t => {
      const attrSymbol = PortfolioSecurityRules.attributionSymbol(t.symbol, t.assetType, t.underlyingSymbol);
      return attrSymbol.toUpperCase() === targetSymbol.toUpperCase() && t.market === targetMarket;
    });

    // 2. Separate into stock-only and option-only transactions
    const stockTxns = securityTxns.filter(t => t.assetType !== 'OPTION');
    const optionTxns = securityTxns.filter(t => t.assetType === 'OPTION');

    // 3. Run calculator to get position values
    const stockSnap = calculator.calculate(stockTxns, quotes, defaultExchangeRates);
    const optionSnap = calculator.calculate(optionTxns, quotes, defaultExchangeRates);

    // 4. Calculate PNLs (Realized + Unrealized)
    const stockPnl = stockSnap.unrealizedProfitCny + Object.values(stockSnap.positions).reduce((sum, p) => sum + p.realizedProfit, 0);
    const optionPnl = optionSnap.unrealizedProfitCny + Object.values(optionSnap.positions).reduce((sum, p) => sum + p.realizedProfit, 0);
    const totalPnl = stockPnl + optionPnl;

    // 5. Select active transactions for breakdown calculation
    const currentTabTxns = activeTab === 'OPTION' ? optionTxns : stockTxns;
    const currentSnap = activeTab === 'OPTION' ? optionSnap : stockSnap;

    // Calculate breakdown stats for the selected tab
    let tabBuyCost = 0;
    let tabSellProceeds = 0;
    let tabFees = 0;

    currentTabTxns.forEach(t => {
      const mult = PortfolioSecurityRules.optionMultiplier(t.assetType, t.symbol);
      const subtotal = t.price * t.quantity * mult;
      
      if (t.tradeType === 'BUY') {
        tabBuyCost += subtotal;
        tabFees += (t.commission + t.tax);
      } else if (t.tradeType === 'SELL') {
        tabSellProceeds += subtotal;
        tabFees += (t.commission + t.tax);
      } else if (t.tradeType === 'DIVIDEND') {
        tabSellProceeds += subtotal;
        tabFees += t.tax;
      } else if (t.tradeType === 'TAX') {
        tabFees += (t.price * t.quantity);
      } else {
        tabFees += (t.commission + t.tax);
      }
    });

    // Calculate current holdings for the selected tab
    let totalQuantity = 0;
    let closingValue = 0;
    let avgCost = 0;

    if (activeTab === 'STOCK') {
      const posKey = `${targetMarket}:${targetSymbol}`;
      const position = currentSnap.positions[posKey];
      totalQuantity = position ? position.quantity : 0;
      avgCost = position ? position.averageCost : 0;
      
      const quote = quotes.find(q => q.symbol === targetSymbol && q.market === targetMarket);
      const currentPrice = quote?.currentPrice ?? avgCost;
      closingValue = totalQuantity * currentPrice;
    } else {
      // Sum up all option positions for this underlying
      Object.values(currentSnap.positions).forEach(pos => {
        totalQuantity += pos.quantity;
        const quote = quotes.find(q => q.symbol === pos.symbol && q.market === pos.market);
        const currentPrice = quote?.currentPrice ?? pos.averageCost;
        closingValue += pos.quantity * currentPrice * 100;
      });
    }

    // 6. Filter transaction list by date range
    let filteredTxnsList = currentTabTxns;
    const now = new Date();
    let startDateStr = '';

    if (range === 'THIS_MONTH') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      startDateStr = start.toISOString().split('T')[0];
    } else if (range === 'ONE_MONTH') {
      const start = new Date();
      start.setMonth(start.getMonth() - 1);
      startDateStr = start.toISOString().split('T')[0];
    } else if (range === 'SIX_MONTHS') {
      const start = new Date();
      start.setMonth(start.getMonth() - 6);
      startDateStr = start.toISOString().split('T')[0];
    } else if (range === 'THIS_YEAR') {
      const start = new Date(now.getFullYear(), 0, 1);
      startDateStr = start.toISOString().split('T')[0];
    }

    if (startDateStr) {
      filteredTxnsList = currentTabTxns.filter(t => t.tradeDate >= startDateStr);
    }

    // Sort transactions by date and time descending
    filteredTxnsList.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || b.tradeTime.localeCompare(a.tradeTime));

    const quoteForTitle = quotes.find(q => q.symbol === targetSymbol && q.market === targetMarket);

    return {
      securityName: quoteForTitle?.name || (securityTxns[0]?.name) || targetSymbol,
      stockPnl,
      optionPnl,
      totalPnl,
      tabBuyCost,
      tabSellProceeds,
      tabFees,
      closingValue,
      totalQuantity,
      avgCost,
      currentPrice: quoteForTitle?.currentPrice ?? avgCost,
      txnsList: filteredTxnsList
    };
  }, [rawTxns, quotes, targetSymbol, targetMarket, range, activeTab]);

  // Prepare chart data from cached bars and stock transactions
  const { chartBars, stockTrades, hasChartData } = useMemo(() => {
    if (activeTab !== 'STOCK') {
      return {
        chartBars: [],
        stockTrades: [],
        hasChartData: false,
      };
    }

    const allBars = historicalBars.filter((b) => b.resolution === '1d');
    const chartBars = historicalBarsToChartBars(allBars);

    const stockTrades = rawTxns.filter((t) => {
      const attrSymbol = PortfolioSecurityRules.attributionSymbol(
        t.symbol,
        t.assetType,
        t.underlyingSymbol
      );
      return (
        t.assetType !== 'OPTION' &&
        attrSymbol.toUpperCase() === targetSymbol.toUpperCase() &&
        t.market === targetMarket
      );
    });

    return {
      chartBars,
      stockTrades,
      hasChartData: chartBars.length > 0,
    };
  }, [historicalBars, activeTab, rawTxns, targetSymbol, targetMarket]);

  const handleFetchMarketData = async () => {
    setIsFetching(true);
    try {
      await marketCacheManager.queueHistoricalRangeForSecurity(targetSymbol, targetMarket, 'stock', rangeBounds);
      await MarketTaskExecutor.startOrWakeMarketExecutor();
    } catch (err: any) {
      alert(`获取行情失败: ${err.message || err}`);
    } finally {
      setIsFetching(false);
    }
  };

  const getCurrencySymbol = (market: string) => {
    switch (market) {
      case 'US': return '$';
      case 'HK': return 'HK$';
      case 'A_SHARE': return '¥';
      default: return '¥';
    }
  };

  const isProfit = stats.totalPnl >= 0;
  const currency = getCurrencySymbol(targetMarket);

  const rangeCoverage = coverage.find((item) => item.resolution === '1d' && item.fromDate <= rangeBounds.fromDate && item.toDate >= rangeBounds.toDate);
  const needsKlineFill = activeTab === 'STOCK' && (!rangeCoverage || rangeCoverage.coverageStatus !== 'complete' || !hasChartData);

  return (
    <div className="page page-secondary">
      {/* Header */}
      <SecondaryPageHeader title={<span className="secondary-page-title-stack"><span>{stats.securityName} ({targetSymbol}.{targetMarket})</span><small>包含正股及全部关联期权交易</small></span>} fallback="/analysis" />

      {/* Range Segment Selector */}
      <div className="range-selector">
        {['ALL', 'THIS_MONTH', 'ONE_MONTH', 'SIX_MONTHS', 'THIS_YEAR'].map((r) => (
          <button 
            key={r} 
            onClick={() => setRange(r)}
            className={range === r ? 'active' : ''}
          >
            {r === 'ALL' ? '全部' : r === 'THIS_MONTH' ? '本月' : r === 'ONE_MONTH' ? '近1月' : r === 'SIX_MONTHS' ? '近6月' : '本年'}
          </button>
        ))}
      </div>

      {/* Daily Candlestick Chart */}
      {activeTab === 'STOCK' && (
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TrendingUp size={16} className="text-muted" />
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>日K线走势</span>
          </div>

          {hasChartData ? (
            <StockChart
              bars={chartBars}
              trades={stockTrades}
              timeRange={range as ChartRange}
              colorScheme={colorScheme}
              height={320}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 0', textAlign: 'center' }}>
              <div className="text-sm text-muted">
                暂无该证券的日K线缓存，无法绘制走势图。
                <br />
                请确保已配置行情API，然后点击获取。
              </div>
              <button
                className="primary"
                onClick={handleFetchMarketData}
                disabled={isFetching}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', margin: '0 auto', width: 'auto' }}
              >
                {isFetching ? <RefreshCw size={16} className="spin" /> : <RefreshCw size={16} />}
                获取行情（API）
              </button>
            </div>
          )}
          {needsKlineFill && hasChartData && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '8px', borderTop: '1px solid var(--border-color)' }}>
              <span className="text-xs text-muted" style={{ flex: 1 }}>当前时间范围内日 K 线不完整，可按需补齐。</span>
              <button className="primary" onClick={handleFetchMarketData} disabled={isFetching} style={{ minHeight: 34, fontSize: 12 }}>{isFetching ? <RefreshCw size={14} className="spin" /> : null}补齐日K线</button>
            </div>
          )}
        </div>
      )}

      {/* PnL Card */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', borderLeft: `4px solid ${isProfit ? 'var(--market-up)' : 'var(--market-down)'}` }}>
        <div className="text-xs text-muted">区间累计估算总盈亏 ({targetMarket === 'US' ? 'USD' : 'CNY'})</div>
        <div style={{ 
          fontSize: '2rem', 
          fontWeight: 700, 
          color: isProfit ? 'var(--market-up)' : 'var(--market-down)'
        }}>
          {isProfit ? '+' : ''}{stats.totalPnl.toFixed(2)}
        </div>

        <div className="grid-cols-2" style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem', marginTop: '0.25rem' }}>
          <div>
            <div className="text-xs text-muted">正股盈亏</div>
            <div style={{ fontWeight: 600, color: stats.stockPnl >= 0 ? 'var(--market-up)' : 'var(--market-down)' }}>
              {stats.stockPnl >= 0 ? '+' : ''}{stats.stockPnl.toFixed(2)}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="text-xs text-muted">期权盈亏</div>
            <div style={{ fontWeight: 600, color: stats.optionPnl >= 0 ? 'var(--market-up)' : 'var(--market-down)' }}>
              {stats.optionPnl >= 0 ? '+' : ''}{stats.optionPnl.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Tab Switcher if options exist */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
        <button 
          onClick={() => setActiveTab('STOCK')}
          style={{ 
            flex: 1, 
            background: 'none', 
            border: 'none', 
            borderRadius: 0,
            borderBottom: activeTab === 'STOCK' ? '2px solid var(--accent)' : 'none',
            color: activeTab === 'STOCK' ? 'var(--text-primary)' : 'var(--text-muted)',
            padding: '0.75rem 0',
            cursor: 'pointer'
          }}
        >
          正股详情
        </button>
        <button 
          onClick={() => setActiveTab('OPTION')}
          style={{ 
            flex: 1, 
            background: 'none', 
            border: 'none', 
            borderRadius: 0,
            borderBottom: activeTab === 'OPTION' ? '2px solid var(--accent)' : 'none',
            color: activeTab === 'OPTION' ? 'var(--text-primary)' : 'var(--text-muted)',
            padding: '0.75rem 0',
            cursor: 'pointer'
          }}
        >
          衍生品(期权)明细
        </button>
      </div>

      {/* Profit & Loss Breakdown */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Info size={16} className="text-muted" />
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            {activeTab === 'STOCK' ? '正股盈亏构成' : '期权盈亏构成'}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', fontSize: '0.85rem' }}>
          {activeTab === 'STOCK' ? (
            <>
              <div className="flex-between">
                <span className="text-muted">持股数量:</span>
                <span>{stats.totalQuantity} 股</span>
              </div>
              <div className="flex-between">
                <span className="text-muted">持仓均价:</span>
                <span>{currency}{stats.avgCost.toFixed(2)}</span>
              </div>
              <div className="flex-between">
                <span className="text-muted">当前股价:</span>
                <span>{currency}{stats.currentPrice.toFixed(2)}</span>
              </div>
            </>
          ) : (
            <div className="flex-between">
              <span className="text-muted">持有未平仓合约数:</span>
              <span>{stats.totalQuantity} 张</span>
            </div>
          )}
          <div className="flex-between">
            <span className="text-muted">{activeTab === 'STOCK' ? '期末正股持仓市值:' : '期末期权持仓市值:'}</span>
            <span>{currency}{stats.closingValue.toFixed(2)}</span>
          </div>
          <div style={{ borderTop: '1px dashed var(--border-color)', margin: '0.25rem 0' }} />
          <div className="flex-between">
            <span className="text-muted">{activeTab === 'STOCK' ? '累计买入股票成本:' : '累计买入期权付出权利金:'}</span>
            <span style={{ color: 'var(--color-error)' }}>-{currency}{stats.tabBuyCost.toFixed(2)}</span>
          </div>
          <div className="flex-between">
            <span className="text-muted">{activeTab === 'STOCK' ? '累计卖出股票回收:' : '累计卖出期权收取权利金:'}</span>
            <span style={{ color: 'var(--color-success)' }}>+{currency}{stats.tabSellProceeds.toFixed(2)}</span>
          </div>
          <div className="flex-between">
            <span className="text-muted">佣金及税费:</span>
            <span style={{ color: 'var(--color-error)' }}>-{currency}{stats.tabFees.toFixed(2)}</span>
          </div>
          <div style={{ borderTop: '1px dashed var(--border-color)', margin: '0.25rem 0' }} />
          <div className="flex-between" style={{ fontWeight: 700 }}>
            <span>{activeTab === 'STOCK' ? '正股估算盈亏:' : '期权估算盈亏:'}</span>
            <span style={{ color: (activeTab === 'STOCK' ? stats.stockPnl : stats.optionPnl) >= 0 ? 'var(--market-up)' : 'var(--market-down)' }}>
              {(activeTab === 'STOCK' ? stats.stockPnl : stats.optionPnl) >= 0 ? '+' : ''}
              {(activeTab === 'STOCK' ? stats.stockPnl : stats.optionPnl).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Transaction Details */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileText size={16} className="text-muted" />
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            {activeTab === 'STOCK' ? '正股流水明细' : '期权流水明细'} ({stats.txnsList.length})
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem' }}>
          {stats.txnsList.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '1.5rem 0' }}>
              在此区间内无交易流水
            </div>
          ) : (
            stats.txnsList.map((tx) => {
              const isBuy = tx.tradeType === 'BUY' || tx.tradeType === 'DEPOSIT' || tx.tradeType === 'TRANSFER_IN';
              const mult = PortfolioSecurityRules.optionMultiplier(tx.assetType, tx.symbol);
              const amountVal = tx.price * tx.quantity * mult;

              return (
                <div 
                  key={tx.id} 
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: '0.5rem', cursor: 'pointer' }}
                  onClick={() => navigate(`/transactions/${tx.id}`)}
                >
                  <div className="flex-between">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className={`badge ${isBuy ? 'success' : 'error'}`}>
                        {TradeTypeLabels[tx.tradeType] || tx.tradeType}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                        {tx.quantity} {tx.assetType === 'OPTION' ? '张' : '股'} @ {currency}{tx.price.toFixed(2)}
                      </span>
                      {tx.assetType === 'OPTION' && (
                        <span className="text-xs text-muted font-mono">{tx.symbol}</span>
                      )}
                    </div>
                    <span style={{ 
                      fontWeight: 700, 
                      fontSize: '0.85rem',
                      color: isBuy ? 'var(--color-error)' : 'var(--color-success)' 
                    }}>
                      {isBuy ? '-' : '+'}{currency}{amountVal.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex-between" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <Calendar size={12} />
                      <span>{tx.tradeDate} {tx.tradeTime}</span>
                    </div>
                    <span>手续费: {currency}{(tx.commission + tx.tax).toFixed(2)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
