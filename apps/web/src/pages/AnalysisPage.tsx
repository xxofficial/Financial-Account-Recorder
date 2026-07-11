import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  PieChart as PieIcon, TrendingUp, Calendar, Layers, 
  Award, CalendarDays 
} from 'lucide-react';
import { AppTopActions } from '../app/AppShell';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { PortfolioCalculator, ExchangeRates } from '../core/portfolio/portfolioCalculator';
import { BrokerPlatform, PlatformType } from '../shared/models';
import { 
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer 
} from 'recharts';

const calculator = new PortfolioCalculator();
const defaultExchangeRates: ExchangeRates = {
  usdToCny: 7.20,
  hkdToCny: 0.92,
};
const EMPTY_LIST: never[] = [];

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="glass-card" style={{ padding: '0.5rem 0.75rem', border: '1px solid var(--accent)', fontSize: '0.8rem', backgroundColor: 'rgba(17, 24, 39, 0.95)' }}>
        <div style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{payload[0].payload.fullDate}</div>
        <div style={{ fontWeight: 700, marginTop: '0.25rem', color: 'var(--text-primary)' }}>
          总资产: ¥{payload[0].value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        {payload[1] && (
          <div style={{ color: payload[1].value >= 0 ? 'var(--market-up)' : 'var(--market-down)', marginTop: '0.1rem', fontWeight: 600 }}>
            持仓盈亏: ¥{payload[1].value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        )}
      </div>
    );
  }
  return null;
};

export default function AnalysisPage() {
  const [timeRange, setTimeRange] = useState('1M');
  const navigate = useNavigate();

  // Reactive queries
  const activeLedgerId = useLiveQuery(async () => {
    const setting = await db.appSettings.get('default_ledger');
    return typeof setting === 'number' ? setting : 1;
  }) ?? 1;

  const transactions = useLiveQuery(() => 
    activeLedgerId === 0 ? db.transactions.toArray() : db.transactions.where('ledgerId').equals(activeLedgerId).toArray(),
    [activeLedgerId]
  ) ?? EMPTY_LIST;

  const quotes = useLiveQuery(() => db.quoteSnapshots.toArray()) ?? EMPTY_LIST;
  const historicalBars = useLiveQuery(() => db.historicalDailyBars.toArray()) ?? EMPTY_LIST;

  // Generate historical net worth data points
  const chartData = useMemo(() => {
    if (transactions.length === 0) return [];

    // Determine range in days
    let rangeDays = 30;
    if (timeRange === '3M') rangeDays = 90;
    else if (timeRange === '1Y') rangeDays = 365;
    else if (timeRange === 'ALL') {
      // Find oldest transaction date
      const oldestDateStr = transactions.reduce((oldest, tx) => 
        tx.tradeDate < oldest ? tx.tradeDate : oldest, 
        new Date().toISOString().split('T')[0]
      );
      const oldestDate = new Date(oldestDateStr + 'T00:00:00Z');
      const todayDate = new Date();
      const diffTime = Math.abs(todayDate.getTime() - oldestDate.getTime());
      rangeDays = Math.max(7, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    }

    // We sample exactly 30 points to look clean and run fast
    const pointsCount = 30;
    const step = Math.max(1, Math.floor(rangeDays / pointsCount));
    const data = [];

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

    for (let i = pointsCount - 1; i >= 0; i--) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() - (i * step));
      const dateStr = targetDate.toISOString().split('T')[0];

      // Filter transactions up to this date
      const txsUpToDate = transactions.filter(t => t.tradeDate <= dateStr);
      
      // Synthesize quotes on this specific target date using historical daily close prices
      const dateMap = barsByDateAndKey.get(dateStr);
      const synthQuotes = quotes.map(q => {
        const histPrice = dateMap?.get(`${q.market}:${q.symbol}`);
        return {
          ...q,
          currentPrice: histPrice !== undefined && histPrice !== null ? histPrice : (q.currentPrice ?? 0),
        };
      });

      const snap = calculator.calculate(txsUpToDate, synthQuotes, defaultExchangeRates);
      
      data.push({
        date: dateStr.substring(5), // MM-DD
        fullDate: dateStr,
        '总资产': snap.totalAssetsCny,
        '持仓盈亏': snap.unrealizedProfitCny,
      });
    }

    return data;
  }, [transactions, quotes, historicalBars, timeRange]);

  // Compute allocations
  const { marketAllocations, platformAllocations } = useMemo(() => {
    const snap = calculator.calculate(transactions, quotes, defaultExchangeRates);
    const totalAssets = snap.totalAssetsCny;

    if (totalAssets <= 0) {
      return { marketAllocations: [], platformAllocations: [] };
    }

    // 1. Market allocation breakdown
    let usVal = 0;
    let hkVal = 0;
    let aShareVal = 0;
    
    Object.values(snap.positions).forEach(pos => {
      const quote = quotes.find(q => q.symbol === pos.symbol && q.market === pos.market);
      const currentPrice = quote?.currentPrice ?? pos.averageCost;
      const mult = pos.assetType === 'OPTION' ? 100 : 1;
      const valCny = pos.quantity * currentPrice * mult * (pos.market === 'US' ? defaultExchangeRates.usdToCny : pos.market === 'HK' ? defaultExchangeRates.hkdToCny : 1.0);
      
      if (pos.market === 'US') usVal += valCny;
      else if (pos.market === 'HK') hkVal += valCny;
      else if (pos.market === 'A_SHARE') aShareVal += valCny;
    });

    const cashVal = snap.cashBalanceCny;

    const markets = [
      { name: '美股 US', value: Math.max(0, usVal), color: '#3b82f6' },
      { name: '港股 HK', value: Math.max(0, hkVal), color: '#f59e0b' },
      { name: 'A股 CN', value: Math.max(0, aShareVal), color: '#10b981' },
      { name: '现金 CASH', value: Math.max(0, cashVal), color: '#06b6d4' }
    ];

    const marketTotal = markets.reduce((sum, item) => sum + item.value, 0);
    const marketAllocations = markets.map(m => ({
      ...m,
      percent: marketTotal > 0 ? (m.value / marketTotal) * 100 : 0
    })).filter(m => m.percent > 0.1);

    // 2. Broker Platform allocation breakdown
    const platforms = Array.from(new Set(transactions.map(t => t.platform)));
    const platformsRaw = platforms.map(p => {
      const txs = transactions.filter(t => t.platform === p);
      const platformSnap = calculator.calculate(txs, quotes, defaultExchangeRates);
      return {
        name: BrokerPlatform[p as PlatformType]?.label || p,
        value: platformSnap.totalAssetsCny,
      };
    });

    const platformTotal = platformsRaw.reduce((sum, item) => sum + item.value, 0);
    const platformAllocations = platformsRaw.map(p => ({
      ...p,
      percent: platformTotal > 0 ? (p.value / platformTotal) * 100 : 0
    })).filter(p => p.percent > 0.1)
      .sort((a, b) => b.percent - a.percent);

    return { marketAllocations, platformAllocations };
  }, [transactions, quotes]);

  return (
    <div className="page">
      {/* Header */}
      <div className="screen-header"><div style={{ flex: 1 }}><h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>分析</h1><div className="text-xs text-muted">{activeLedgerId === 0 ? '账本汇总' : '当前账本'}</div></div><AppTopActions /></div>
      <div className="range-selector">
          {['1M', '3M', '1Y', 'ALL'].map((r) => (
            <button
              key={r}
              onClick={() => setTimeRange(r)}
              className={timeRange === r ? 'active' : ''}
            >
              {r}
            </button>
          ))}
      </div>

      {/* Analysis Tools Quick Access */}
      <div className="grid-cols-2" style={{ gap: '0.75rem' }}>
        <button 
          onClick={() => navigate('/analysis/ranking')}
          className="glass-card flex-between" 
          style={{ 
            padding: '0.75rem', 
            cursor: 'pointer',
            textAlign: 'left',
            border: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(255,255,255,0.02)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            width: '100%'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
            <Award size={18} style={{ color: 'var(--accent)' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>盈亏排行榜</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>查看个股表现排行</div>
            </div>
          </div>
        </button>

        <button 
          onClick={() => navigate(`/analysis/calendar/MONTH/${new Date().toISOString().split('T')[0]}`)}
          className="glass-card flex-between" 
          style={{ 
            padding: '0.75rem', 
            cursor: 'pointer',
            textAlign: 'left',
            border: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(255,255,255,0.02)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            width: '100%'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
            <CalendarDays size={18} style={{ color: 'var(--accent)' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>收益日历</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>按日/周/月/年查看</div>
            </div>
          </div>
        </button>
      </div>

      {/* Net Worth Chart */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div className="flex-between">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TrendingUp size={16} className="text-muted" />
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>资产净值曲线</span>
          </div>
          <span className="text-xs text-muted" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <Calendar size={12} />
            {timeRange === '1M' ? '最近30天' : timeRange === '3M' ? '最近90天' : timeRange === '1Y' ? '最近1年' : '历史全部'}
          </span>
        </div>

        {/* Recharts Area Chart */}
        <div style={{ height: '180px', width: '100%', marginTop: '0.5rem' }}>
          {chartData.length === 0 ? (
            <div className="flex-center" style={{ height: '100%', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              无足够的交易数据生成净值曲线
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorAssets" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={10} tickLine={false} />
                <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} tickFormatter={(val) => `¥${Math.round(val).toLocaleString()}`} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="总资产" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorAssets)" />
                <Area type="monotone" dataKey="持仓盈亏" stroke="#8b5cf6" strokeWidth={1} fill="none" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

      </div>

      {/* Asset allocation is intentionally shown only in aggregate mode. */}
      {activeLedgerId === 0 && <><div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <PieIcon size={16} className="text-muted" />
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>资产市场分布</span>
        </div>

        {/* Progress Bar Chart */}
        {marketAllocations.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            暂无资产分布数据
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
            {/* Stacked Progress Bar */}
            <div style={{ display: 'flex', height: '12px', width: '100%', borderRadius: '6px', overflow: 'hidden', backgroundColor: 'var(--bg-input)' }}>
              {marketAllocations.map((item) => (
                <div 
                  key={item.name} 
                  style={{ 
                    width: `${item.percent}%`, 
                    backgroundColor: item.color, 
                    height: '100%' 
                  }} 
                />
              ))}
            </div>

            {/* Allocation Legend */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {marketAllocations.map((item) => (
                <div key={item.name} className="flex-between text-sm">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: item.color }} />
                    <span>{item.name}</span>
                  </div>
                  <span style={{ fontWeight: 600 }}>
                    ¥{item.value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({item.percent.toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Platform Allocation */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Layers size={16} className="text-muted" />
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>券商平台分布</span>
        </div>
        
        {platformAllocations.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            暂无平台分布数据
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
            {platformAllocations.map((plat) => (
              <div key={plat.name} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <div className="flex-between text-xs text-secondary">
                  <span>{plat.name}</span>
                  <span style={{ fontWeight: 600 }}>
                    ¥{plat.value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({plat.percent.toFixed(1)}%)
                  </span>
                </div>
                {/* Single Platform bar */}
                <div style={{ height: '6px', width: '100%', borderRadius: '3px', backgroundColor: 'var(--bg-input)', overflow: 'hidden' }}>
                  <div style={{ width: `${plat.percent}%`, height: '100%', background: 'var(--accent-gradient)', borderRadius: '3px' }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div></>}
    </div>
  );
}
