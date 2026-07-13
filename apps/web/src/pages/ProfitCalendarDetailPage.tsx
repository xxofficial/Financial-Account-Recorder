import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { useAppShell } from '../app/AppShell';
import { PortfolioCalculator, ExchangeRates, convertToCny, PortfolioSecurityRules } from '../core/portfolio/portfolioCalculator';
import { ArrowLeft, ChevronLeft, ChevronRight, Info, TrendingUp } from 'lucide-react';

type Mode = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
type Unit = 'AMOUNT' | 'PERCENT';

const calculator = new PortfolioCalculator();
const defaultExchangeRates: ExchangeRates = {
  usdToCny: 7.20,
  hkdToCny: 0.92,
};
const EMPTY_LIST: never[] = [];

export default function ProfitCalendarDetailPage() {
  const { mode: urlMode, date: urlDate } = useParams();
  const navigate = useNavigate();
  const { activePlatform } = useAppShell();

  const [mode, setMode] = useState<Mode>((urlMode as Mode) || 'MONTH');
  const [selectedDate, setSelectedDate] = useState<string>(urlDate || new Date().toISOString().split('T')[0]);
  const [unit, setUnit] = useState<Unit>('AMOUNT');

  // Reactive DB queries
  const activeLedgerId = useLiveQuery(async () => {
    const setting = await db.appSettings.get('default_ledger');
    return typeof setting === 'number' ? setting : 1;
  }) ?? 1;

  const rawTxns = useLiveQuery(async () => {
    const ledgerTransactions = activeLedgerId === 0 ? await db.transactions.toArray() : await db.transactions.where('ledgerId').equals(activeLedgerId).toArray();
    return activePlatform === null ? ledgerTransactions : ledgerTransactions.filter((transaction) => transaction.platform === activePlatform);
  }, [activeLedgerId, activePlatform]) ?? EMPTY_LIST;

  const quotes = useLiveQuery(() => db.quoteSnapshots.toArray()) ?? EMPTY_LIST;
  const historicalBars = useLiveQuery(() => db.historicalDailyBars.toArray()) ?? EMPTY_LIST;

  // Parse current date context
  const parsedDate = useMemo(() => new Date(selectedDate), [selectedDate]);

  // Navigate periods
  const handlePrevPeriod = () => {
    const dt = new Date(parsedDate);
    if (mode === 'MONTH') {
      dt.setMonth(dt.getMonth() - 1);
    } else if (mode === 'YEAR') {
      dt.setFullYear(dt.getFullYear() - 1);
    } else {
      dt.setDate(dt.getDate() - 7);
    }
    setSelectedDate(dt.toISOString().split('T')[0]);
  };

  const handleNextPeriod = () => {
    const dt = new Date(parsedDate);
    if (mode === 'MONTH') {
      dt.setMonth(dt.getMonth() + 1);
    } else if (mode === 'YEAR') {
      dt.setFullYear(dt.getFullYear() + 1);
    } else {
      dt.setDate(dt.getDate() + 7);
    }
    setSelectedDate(dt.toISOString().split('T')[0]);
  };

  // Generate calendar days for selected month
  const calendarData = useMemo(() => {
    if (rawTxns.length === 0) return { days: [], stats: { totalPnl: 0, returnPercent: 0, winRate: '0%', maxDrawdown: '0%', avgDailyPnl: 0, bestDayPnl: 0 }, securities: [] };

    const year = parsedDate.getFullYear();
    const month = parsedDate.getMonth(); // 0-indexed

    // Number of days in selected month
    const totalDays = new Date(year, month + 1, 0).getDate();
    const days = [];

    let totalPnl = 0;
    let winDays = 0;
    let activeDays = 0;
    let bestDayPnl = 0;
    let maxPeak = 0;
    let maxDd = 0;

    // Group historical bars by date and key: key is `${market}:${symbol}`
    const barsByDateAndKey = new Map<string, Map<string, number>>();
    historicalBars.forEach(bar => {
      let dateMap = barsByDateAndKey.get(bar.date);
      if (!dateMap) {
        dateMap = new Map<string, number>();
        barsByDateAndKey.set(bar.date, dateMap);
      }
      dateMap.set(`${bar.market}:${bar.symbol}`, bar.close);
    });

    const getQuotesForDate = (dStr: string) => {
      const dateMap = barsByDateAndKey.get(dStr);
      return quotes.map(q => {
        const histPrice = dateMap?.get(`${q.market}:${q.symbol}`);
        return {
          ...q,
          currentPrice: histPrice !== undefined && histPrice !== null ? histPrice : (q.currentPrice ?? 0),
        };
      });
    };

    // We calculate daily assets and deposits to derive daily PNL
    for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
      const dateStr = `${year}-${(month + 1).toString().padStart(2, '0')}-${dayNum.toString().padStart(2, '0')}`;
      
      // Filter transactions up to today
      const txsUpToToday = rawTxns.filter(t => t.tradeDate <= dateStr);
      const synthQuotesToday = getQuotesForDate(dateStr);
      const snapToday = calculator.calculate(txsUpToToday, synthQuotesToday, defaultExchangeRates);
      
      // Filter transactions up to yesterday
      const yesterday = new Date(year, month, dayNum - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      const txsUpToYesterday = rawTxns.filter(t => t.tradeDate <= yesterdayStr);
      const synthQuotesYesterday = getQuotesForDate(yesterdayStr);
      const snapYesterday = calculator.calculate(txsUpToYesterday, synthQuotesYesterday, defaultExchangeRates);

      // Find net deposit for this specific day
      const dayTxns = rawTxns.filter(t => t.tradeDate === dateStr);
      const dayNetDeposit = dayTxns.reduce((sum, t) => {
        const mult = PortfolioSecurityRules.optionMultiplier(t.assetType, t.symbol);
        const amt = convertToCny(t.price * t.quantity * mult, t.market, defaultExchangeRates);
        if (t.tradeType === 'DEPOSIT') return sum + amt;
        if (t.tradeType === 'WITHDRAW') return sum - amt;
        return sum;
      }, 0);

      // Daily PnL = Assets Today - Assets Yesterday - Net Deposit Today
      const pnl = snapToday.totalAssetsCny - snapYesterday.totalAssetsCny - dayNetDeposit;

      // Metrics Tally
      totalPnl += pnl;
      if (Math.abs(pnl) > 0.05) {
        activeDays++;
        if (pnl > 0) winDays++;
        bestDayPnl = Math.max(bestDayPnl, pnl);
      }

      // Max drawdown calculations
      maxPeak = Math.max(maxPeak, snapToday.totalAssetsCny);
      const dd = maxPeak > 0 ? (maxPeak - snapToday.totalAssetsCny) / maxPeak : 0;
      maxDd = Math.max(maxDd, dd);

      days.push({ dayNum, dateStr, pnl });
    }

    // Win rate
    const winRateVal = activeDays > 0 ? (winDays / activeDays) * 100 : 0;
    const winRate = `${winRateVal.toFixed(0)}%`;

    // Average daily pnl
    const avgDailyPnl = activeDays > 0 ? totalPnl / activeDays : 0;

    // Filter transactions during this month to calculate security contribution
    const monthStartStr = `${year}-${(month + 1).toString().padStart(2, '0')}-01`;
    const monthEndStr = `${year}-${(month + 1).toString().padStart(2, '0')}-${totalDays.toString().padStart(2, '0')}`;
    
    const monthTxns = rawTxns.filter(t => t.tradeDate >= monthStartStr && t.tradeDate <= monthEndStr);
    const synthQuotesMonthEnd = getQuotesForDate(monthEndStr);
    const monthSnap = calculator.calculate(monthTxns, synthQuotesMonthEnd, defaultExchangeRates);

    const securities = Object.values(monthSnap.positions).map(pos => {
      const dateMap = barsByDateAndKey.get(monthEndStr);
      const histPrice = dateMap?.get(`${pos.market}:${pos.symbol}`);
      const currentPrice = histPrice !== undefined && histPrice !== null ? histPrice : pos.averageCost;
      const mult = pos.assetType === 'OPTION' ? 100 : 1;
      const val = pos.quantity * currentPrice * mult;
      
      const unrealized = val - pos.remainingCost;
      const pnl = unrealized + pos.realizedProfit;
      const pnlCny = convertToCny(pnl, pos.market, defaultExchangeRates);

      return {
        symbol: pos.symbol,
        market: pos.market,
        name: pos.name,
        pnl: pnlCny,
        assetType: pos.assetType,
        underlyingSymbol: pos.underlyingSymbol
      };
    }).filter(item => Math.abs(item.pnl) > 0.05)
      .sort((a, b) => b.pnl - a.pnl);

    // Initial assets for percentage return calculation
    const initialTxs = rawTxns.filter(t => t.tradeDate < monthStartStr);
    const yesterdayStart = new Date(year, month, 0); // last day of previous month
    const yesterdayStartStr = yesterdayStart.toISOString().split('T')[0];
    const synthQuotesInitial = getQuotesForDate(yesterdayStartStr);
    const initialSnap = calculator.calculate(initialTxs, synthQuotesInitial, defaultExchangeRates);
    const returnPercent = initialSnap.totalAssetsCny > 0 ? (totalPnl / initialSnap.totalAssetsCny) * 100 : 0;

    return {
      days,
      stats: {
        totalPnl,
        returnPercent,
        winRate,
        maxDrawdown: `-${(maxDd * 100).toFixed(1)}%`,
        avgDailyPnl,
        bestDayPnl
      },
      securities
    };
  }, [rawTxns, quotes, historicalBars, parsedDate]);

  const formattedPeriodTitle = useMemo(() => {
    if (mode === 'MONTH') {
      return `${parsedDate.getFullYear()}年 ${parsedDate.getMonth() + 1}月`;
    } else if (mode === 'YEAR') {
      return `${parsedDate.getFullYear()}年`;
    } else {
      return `${parsedDate.getFullYear()}年${parsedDate.getMonth() + 1}月${parsedDate.getDate()}日`;
    }
  }, [parsedDate, mode]);

  // First day of month padding calculation
  const paddingDaysCount = useMemo(() => {
    const firstDay = new Date(parsedDate.getFullYear(), parsedDate.getMonth(), 1);
    return firstDay.getDay(); // 0 = Sunday, 1 = Monday, etc.
  }, [parsedDate]);

  return (
    <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <button onClick={() => navigate(-1)} style={{ padding: '0.5rem', background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700 }}>收益日历</h1>
      </div>

      {/* Mode Selector */}
      <div className="flex-between" style={{ gap: '0.5rem' }}>
        {/* Modes */}
        <div style={{ display: 'flex', backgroundColor: 'var(--bg-input)', borderRadius: '20px', padding: '2px' }}>
          {(['MONTH'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                border: 'none',
                padding: '0.35rem 0.9rem',
                fontSize: '0.75rem',
                borderRadius: '18px',
                backgroundColor: mode === m ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                color: mode === m ? 'var(--accent)' : 'var(--text-muted)',
                cursor: 'pointer'
              }}
            >
              月度视图
            </button>
          ))}
        </div>

        {/* Units */}
        <div style={{ display: 'flex', backgroundColor: 'var(--bg-input)', borderRadius: '20px', padding: '2px' }}>
          {(['AMOUNT'] as Unit[]).map((u) => (
            <button
              key={u}
              onClick={() => setUnit(u)}
              style={{
                border: 'none',
                padding: '0.35rem 0.9rem',
                fontSize: '0.75rem',
                borderRadius: '18px',
                backgroundColor: unit === u ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                color: unit === u ? 'var(--accent)' : 'var(--text-muted)',
                cursor: 'pointer'
              }}
            >
              人民币金币金额
            </button>
          ))}
        </div>
      </div>

      {/* Calendar widget navigation */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem' }}>
        <div className="flex-between">
          <button onClick={handlePrevPeriod} style={{ background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <ChevronLeft size={18} />
          </button>
          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{formattedPeriodTitle}</span>
          <button onClick={handleNextPeriod} style={{ background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Mini Calendar View Grid */}
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(7, 1fr)', 
          gap: '0.25rem', 
          fontSize: '0.75rem', 
          textAlign: 'center',
          marginTop: '0.5rem' 
        }}>
          {/* Weekday headers */}
          {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
            <span key={d} style={{ color: 'var(--text-muted)', fontWeight: 600, paddingBottom: '0.25rem' }}>{d}</span>
          ))}
          {/* Pad first week */}
          {Array.from({ length: paddingDaysCount }).map((_, i) => (
            <div key={`pad-${i}`} />
          ))}
          {/* Days */}
          {calendarData.days.map((day) => {
            const hasPnl = Math.abs(day.pnl) > 0.05;
            const isSelected = selectedDate === day.dateStr;
            return (
              <div 
                key={day.dayNum} 
                onClick={() => setSelectedDate(day.dateStr)}
                style={{
                  padding: '0.35rem 0',
                  borderRadius: '6px',
                  backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                  border: isSelected ? '1px solid var(--accent)' : 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  minHeight: '2.25rem',
                  justifyContent: 'space-between',
                }}
              >
                <span style={{ 
                  fontWeight: isSelected ? 700 : 400,
                  color: isSelected ? 'var(--accent)' : 'var(--text-primary)'
                }}>{day.dayNum}</span>
                {hasPnl && (
                  <div style={{ 
                    width: '4px', 
                    height: '4px', 
                    borderRadius: '50%', 
                    backgroundColor: day.pnl > 0 ? 'var(--color-success)' : 'var(--color-error)' 
                  }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Period Stats Summary Grid */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Info size={16} className="text-muted" />
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>月度收益剖析</span>
        </div>

        <div className="grid-cols-2" style={{ gap: '0.75rem' }}>
          <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div className="text-xs text-muted">月度累计盈亏</div>
            <div style={{ fontWeight: 700, color: calendarData.stats.totalPnl >= 0 ? 'var(--color-success)' : 'var(--color-error)', fontSize: '1.05rem', marginTop: '0.15rem' }}>
              {calendarData.stats.totalPnl >= 0 ? '+' : ''}¥{calendarData.stats.totalPnl.toFixed(2)}
            </div>
          </div>

          <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div className="text-xs text-muted">本月估算收益率</div>
            <div style={{ fontWeight: 700, color: calendarData.stats.returnPercent >= 0 ? 'var(--color-success)' : 'var(--color-error)', fontSize: '1.05rem', marginTop: '0.15rem' }}>
              {calendarData.stats.returnPercent >= 0 ? '+' : ''}{calendarData.stats.returnPercent.toFixed(2)}%
            </div>
          </div>

          <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div className="text-xs text-muted">盈利天数占比 (胜率)</div>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginTop: '0.15rem' }}>
              {calendarData.stats.winRate}
            </div>
          </div>

          <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div className="text-xs text-muted">最大回撤幅度</div>
            <div style={{ fontWeight: 600, color: 'var(--color-error)', fontSize: '0.95rem', marginTop: '0.15rem' }}>
              {calendarData.stats.maxDrawdown}
            </div>
          </div>

          <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div className="text-xs text-muted">活跃日均盈亏</div>
            <div style={{ fontWeight: 600, color: calendarData.stats.avgDailyPnl >= 0 ? 'var(--color-success)' : 'var(--color-error)', fontSize: '0.95rem', marginTop: '0.15rem' }}>
              {calendarData.stats.avgDailyPnl >= 0 ? '+' : ''}¥{calendarData.stats.avgDailyPnl.toFixed(2)}
            </div>
          </div>

          <div style={{ padding: '0.5rem', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div className="text-xs text-muted">单日最高盈利金额</div>
            <div style={{ fontWeight: 600, color: 'var(--color-success)', fontSize: '0.95rem', marginTop: '0.15rem' }}>
              +¥{calendarData.stats.bestDayPnl.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Securities Performance List in this period */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <TrendingUp size={16} className="text-muted" />
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>本月个股贡献排行榜</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {calendarData.securities.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '1.5rem 0' }}>
              本月无交易标的贡献数据
            </div>
          ) : (
            calendarData.securities.map((item) => {
              const isProfit = item.pnl >= 0;
              return (
                <div 
                  key={`${item.market}:${item.symbol}`} 
                  onClick={() => {
                    const targetSymbol = PortfolioSecurityRules.attributionSymbol(
                      item.symbol,
                      item.assetType,
                      item.underlyingSymbol
                    );
                    navigate(`/analysis/stock/${targetSymbol}/${item.market}`);
                  }}
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between', 
                    padding: '0.6rem 0.5rem',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                  className="list-item-hover"
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{item.name}</div>
                    <div className="text-xs text-muted">{item.symbol}.{item.market}</div>
                  </div>
                  <div style={{ 
                    fontWeight: 700, 
                    fontSize: '0.85rem',
                    color: isProfit ? 'var(--color-success)' : 'var(--color-error)'
                  }}>
                    {isProfit ? '+' : ''}¥{item.pnl.toFixed(2)}
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
