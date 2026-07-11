import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, ChevronRight, DollarSign } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { PortfolioCalculator, ExchangeRates, PortfolioSecurityRules } from '../core/portfolio/portfolioCalculator';
import { AppTopActions } from '../app/AppShell';

const calculator = new PortfolioCalculator();
const rates: ExchangeRates = { usdToCny: 7.2, hkdToCny: .92 };
const EMPTY: never[] = [];
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PortfolioPage() {
  const navigate = useNavigate(); const [refreshing, setRefreshing] = useState(false);
  const selectedLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value) ?? 1;
  const ledger = useLiveQuery(() => selectedLedgerId === 0 ? undefined : db.ledgers.get(selectedLedgerId as number), [selectedLedgerId]);
  const transactions = useLiveQuery(async () => selectedLedgerId === 0 ? db.transactions.toArray() : db.transactions.where('ledgerId').equals(selectedLedgerId as number).toArray(), [selectedLedgerId]) ?? EMPTY;
  const quotes = useLiveQuery(() => db.quoteSnapshots.toArray()) ?? EMPTY;
  const snapshot = useMemo(() => calculator.calculate(transactions, quotes, rates), [transactions, quotes]);
  const holdings = useMemo(() => Object.values(snapshot.positions).filter((item) => Math.abs(item.quantity) > 1e-5), [snapshot]);
  const refresh = async () => { if (!holdings.length || refreshing) return; setRefreshing(true); try { const { cacheService } = await import('../core/market/marketDataCacheService'); await cacheService.refreshQuotes(holdings.map((item) => ({ symbol: item.symbol, market: item.market, assetType: item.assetType })), true); } finally { setRefreshing(false); } };
  const currency = (market: string) => market === 'US' ? '$' : market === 'HK' ? 'HK$' : '¥';
  const pnlClass = (value: number) => value >= 0 ? 'market-up' : 'market-down';
  return <div className="page">
    <div className="screen-header"><div style={{ flex: 1, minWidth: 0 }}><h1>持仓</h1><div className="text-xs text-muted">{selectedLedgerId === 0 ? '账本汇总' : ledger?.name ?? '默认个人账本'}</div></div><AppTopActions onRefresh={() => void refresh()} refreshing={refreshing} /></div>
    <section>
      <div className="text-sm text-muted">总资产估值（CNY）</div>
      <div style={{ fontSize: 30, lineHeight: '40px', fontWeight: 750, letterSpacing: -.5 }}>¥{money(snapshot.totalAssetsCny)}</div>
      <div className={pnlClass(snapshot.dayProfitCny)} style={{ marginTop: 4, fontSize: 14, fontWeight: 700 }}>今日盈亏 {snapshot.dayProfitCny >= 0 ? '+' : ''}{money(snapshot.dayProfitCny)}（{snapshot.dayProfitCny >= 0 ? '+' : ''}{snapshot.dayProfitPercent.toFixed(2)}%）</div>
    </section>
    <div className="metric-grid"><div className="metric"><div className="metric-label">可用现金</div><div className="metric-value">¥{money(snapshot.cashBalanceCny)}</div></div><div className="metric"><div className="metric-label">证券市值</div><div className="metric-value">¥{money(snapshot.holdingsValueCny)}</div></div><div className="metric"><div className="metric-label">累计持仓盈亏</div><div className={`metric-value ${pnlClass(snapshot.unrealizedProfitCny)}`}>{snapshot.unrealizedProfitCny >= 0 ? '+' : ''}{money(snapshot.unrealizedProfitCny)}</div></div><div className="metric"><div className="metric-label">持仓数量</div><div className="metric-value">{holdings.length} 个</div></div></div>
    <section><div className="flex-between" style={{ margin: '4px 0 8px' }}><h2 className="section-title">持有明细</h2><span className="text-xs text-muted">{holdings.length} 个标的</span></div>
      <div className="surface-list">{holdings.length === 0 ? <div className="text-sm text-muted" style={{ padding: '32px 16px', textAlign: 'center' }}>暂无持仓，点击底部“+”记一笔交易</div> : holdings.map((item) => {
        const quote = quotes.find((q) => q.symbol === item.symbol && q.market === item.market); const price = quote?.currentPrice ?? item.averageCost; const multiplier = item.assetType === 'OPTION' ? 100 : 1; const value = item.quantity * price * multiplier; const cost = item.quantity * item.averageCost * multiplier; const pnl = value - cost; const symbol = PortfolioSecurityRules.attributionSymbol(item.symbol, item.assetType, item.underlyingSymbol);
        return <button key={`${item.market}:${item.symbol}`} className="list-row" onClick={() => navigate(`/analysis/stock/${symbol}/${item.market}`)}><Briefcase size={20} /><span className="list-row-main"><span className="list-row-title">{item.name || item.symbol} <span className="text-xs text-muted">{item.symbol}</span></span><span className="list-row-desc">{item.quantity} {item.assetType === 'OPTION' ? '张' : '股'} · 成本 {currency(item.market)}{item.averageCost.toFixed(2)} · 现价 {currency(item.market)}{price.toFixed(2)}</span></span><span style={{ textAlign: 'right' }}><span style={{ display: 'block', fontWeight: 700 }}>{currency(item.market)}{money(value)}</span><span className={`text-xs ${pnlClass(pnl)}`}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}</span></span><ChevronRight size={16} className="text-muted" /></button>;
      })}</div></section>
    <div className="surface-card text-xs text-muted"><DollarSign size={15} style={{ verticalAlign: 'middle', marginRight: 6 }} />实时价格仅在右上角刷新时更新；历史行情补齐状态会在页面顶部提示。</div>
  </div>;
}
