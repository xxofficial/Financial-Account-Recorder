import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { useAppShell } from '../app/AppShell';
import { PortfolioCalculator, ExchangeRates, convertToCny, PortfolioSecurityRules } from '../core/portfolio/portfolioCalculator';
import { ArrowLeft, TrendingUp, TrendingDown, ArrowUpDown } from 'lucide-react';

const calculator = new PortfolioCalculator();
const defaultExchangeRates: ExchangeRates = {
  usdToCny: 7.20,
  hkdToCny: 0.92,
};
const EMPTY_LIST: never[] = [];

export default function FullRankingPage() {
  const navigate = useNavigate();
  const { activePlatform } = useAppShell();
  const [range, setRange] = useState('ALL');
  const [showProfit, setShowProfit] = useState(true);
  const [sortAscending, setSortAscending] = useState(false);

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

  // Calculate and sort ranking list
  const rankingList = useMemo(() => {
    if (rawTxns.length === 0) return [];

    // Filter transactions by range
    let filteredTxns = rawTxns;
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
      filteredTxns = rawTxns.filter(t => t.tradeDate >= startDateStr);
    }

    // Run portfolio calculator on filtered transactions
    const snap = calculator.calculate(filteredTxns, quotes, defaultExchangeRates);

    // Group profits/losses in CNY by symbol
    const rankings = Object.values(snap.positions).map(pos => {
      const quote = quotes.find(q => q.symbol === pos.symbol && q.market === pos.market);
      const currentPrice = quote?.currentPrice ?? pos.averageCost;
      const mult = pos.assetType === 'OPTION' ? 100 : 1;
      const currentValue = pos.quantity * currentPrice * mult;
      
      const unrealized = currentValue - pos.remainingCost;
      const totalPnl = unrealized + pos.realizedProfit;
      const totalPnlCny = convertToCny(totalPnl, pos.market, defaultExchangeRates);

      return {
        symbol: pos.symbol,
        market: pos.market,
        name: pos.name,
        profit: totalPnlCny,
        assetType: pos.assetType,
        underlyingSymbol: pos.underlyingSymbol
      };
    }).filter(item => item.market !== 'CASH' && item.symbol !== 'CASH');

    // Filter by Profit vs Loss
    const filtered = rankings.filter(item => {
      if (showProfit) return item.profit >= 0;
      return item.profit < 0;
    });

    // Sort by profit
    filtered.sort((a, b) => {
      if (sortAscending) return a.profit - b.profit;
      return b.profit - a.profit;
    });

    return filtered;
  }, [rawTxns, quotes, range, showProfit, sortAscending]);

  return (
    <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <button onClick={() => navigate(-1)} style={{ padding: '0.5rem', background: 'none', border: 'none', color: 'var(--text-primary)', cursor: 'pointer' }}>
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700 }}>盈亏排行</h1>
      </div>

      {/* Range Selector */}
      <div className="flex-between gap-2" style={{ overflowX: 'auto', paddingBottom: '0.25rem' }}>
        {['ALL', 'THIS_MONTH', 'ONE_MONTH', 'SIX_MONTHS', 'THIS_YEAR'].map((r) => (
          <button 
            key={r} 
            onClick={() => setRange(r)}
            style={{ 
              padding: '0.4rem 0.8rem', 
              fontSize: '0.8rem', 
              borderRadius: '20px',
              border: range === r ? '1px solid var(--accent)' : '1px solid var(--border-color)',
              backgroundColor: range === r ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-input)',
              color: range === r ? 'var(--accent)' : 'var(--text-primary)',
              whiteSpace: 'nowrap',
              cursor: 'pointer'
            }}
          >
            {r === 'ALL' ? '全部' : r === 'THIS_MONTH' ? '本月' : r === 'ONE_MONTH' ? '近1月' : r === 'SIX_MONTHS' ? '近6月' : '本年'}
          </button>
        ))}
      </div>

      {/* Toggle Tabs (Profit vs Loss) */}
      <div className="flex-between" style={{ gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            onClick={() => { setShowProfit(true); setSortAscending(false); }}
            style={{ 
              padding: '0.4rem 0.9rem', 
              fontSize: '0.8rem', 
              borderRadius: '20px',
              border: showProfit ? 'none' : '1px solid var(--border-color)',
              backgroundColor: showProfit ? 'var(--color-success)' : 'var(--bg-input)',
              color: showProfit ? '#ffffff' : 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              cursor: 'pointer'
            }}
          >
            <TrendingUp size={14} />
            盈利排行
          </button>
          <button 
            onClick={() => { setShowProfit(false); setSortAscending(true); }}
            style={{ 
              padding: '0.4rem 0.9rem', 
              fontSize: '0.8rem', 
              borderRadius: '20px',
              border: !showProfit ? 'none' : '1px solid var(--border-color)',
              backgroundColor: !showProfit ? 'var(--color-error)' : 'var(--bg-input)',
              color: !showProfit ? '#ffffff' : 'var(--text-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
              cursor: 'pointer'
            }}
          >
            <TrendingDown size={14} />
            亏损排行
          </button>
        </div>

        <button 
          onClick={() => setSortAscending(!sortAscending)}
          style={{ 
            padding: '0.4rem 0.6rem', 
            fontSize: '0.8rem', 
            borderRadius: '20px',
            border: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-input)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            color: 'var(--text-primary)',
            cursor: 'pointer'
          }}
        >
          <ArrowUpDown size={12} />
          {sortAscending ? '升序' : '降序'}
        </button>
      </div>

      {/* Rankings List */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', padding: '0.5rem' }}>
        {rankingList.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
            没有符合条件的交易数据
          </div>
        ) : (
          rankingList.map((item, idx) => {
            const displayIdx = idx + 1;
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
                  gap: '0.75rem', 
                  padding: '0.75rem', 
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
                className="list-item-hover"
              >
                {/* Rank Number Badge */}
                <div style={{ 
                  width: '24px', 
                  height: '24px', 
                  borderRadius: '50%', 
                  backgroundColor: displayIdx <= 3 ? (showProfit ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)') : 'rgba(255,255,255,0.03)',
                  color: displayIdx <= 3 ? (showProfit ? 'var(--color-success)' : 'var(--color-error)') : 'var(--text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: '0.8rem'
                }}>
                  {displayIdx}
                </div>

                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{item.name}</div>
                  <div className="text-xs text-muted">{item.symbol}.{item.market}</div>
                </div>

                <div style={{ 
                  fontWeight: 700, 
                  color: item.profit >= 0 ? 'var(--color-success)' : 'var(--color-error)' 
                }}>
                  {item.profit >= 0 ? '+' : ''}¥{item.profit.toFixed(2)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
