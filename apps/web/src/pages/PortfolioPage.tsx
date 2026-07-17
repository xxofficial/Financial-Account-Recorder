import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown } from 'lucide-react';
import { db } from '../db/localDb';
import { PortfolioCalculator, ExchangeRates } from '../core/portfolio/portfolioCalculator';
import { securityDetailPath } from '../core/portfolio/securityDetailRoute';
import { CurrencyType, DisplayCurrency } from '../shared/models';
import { useAppShell } from '../app/AppShell';
import { AdaptiveSingleLineText } from '../components/AdaptiveSingleLineText';
import { computeJointContributions, scalePortfolioSnapshot } from '../core/portfolio/jointLedger';

const calculator = new PortfolioCalculator();
const rates: ExchangeRates = { usdToCny: 7.2, hkdToCny: .92 };
const EMPTY: never[] = [];
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PortfolioPage() {
  const navigate = useNavigate();
  const { registerPortfolioRefresh, activePlatform } = useAppShell();
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [selectedPartner, setSelectedPartner] = useState<string | null>(null);
  const selectedLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value) ?? 1;
  const ledger = useLiveQuery(() => typeof selectedLedgerId === 'number' ? db.ledgers.get(selectedLedgerId) : undefined, [selectedLedgerId]);
  const transactions = useLiveQuery(async () => {
    const ledgerTransactions = selectedLedgerId === 0
      ? await db.transactions.toArray()
      : await db.transactions.where('ledgerId').equals(selectedLedgerId as number).toArray();
    return activePlatform === null ? ledgerTransactions : ledgerTransactions.filter((transaction) => transaction.platform === activePlatform);
  }, [selectedLedgerId, activePlatform]) ?? EMPTY;
  const quotes = useLiveQuery(() => db.quoteSnapshots.toArray()) ?? EMPTY;
  const storedCurrency = useLiveQuery(async () => (await db.appSettings.get('display_currency'))?.value) ?? 'CNY';
  const displayCurrency = DisplayCurrency[storedCurrency as CurrencyType] ?? DisplayCurrency.CNY;
  const snapshot = useMemo(() => calculator.calculate(transactions, quotes, rates), [transactions, quotes]);
  const contributions = useMemo(() => computeJointContributions(ledger, transactions, quotes, rates), [ledger, transactions, quotes]);
  const activeContribution = contributions.find((item) => item.name === selectedPartner);
  const viewRatio = activeContribution?.ratio ?? 1;
  const viewSnapshot = useMemo(() => scalePortfolioSnapshot(snapshot, viewRatio), [snapshot, viewRatio]);
  const holdings = useMemo(() => Object.values(viewSnapshot.positions).filter((item) => Math.abs(item.quantity) > 1e-5), [viewSnapshot]);
  useEffect(() => {
    if (selectedPartner && !activeContribution) setSelectedPartner(null);
  }, [activeContribution, selectedPartner]);
  const refresh = useCallback(async () => {
    if (!holdings.length) return;
    const { cacheService } = await import('../core/market/marketDataCacheService');
    await cacheService.refreshQuotes(holdings.map((item) => ({ symbol: item.symbol, market: item.market, assetType: item.assetType })), true);
  }, [holdings]);
  useEffect(() => {
    registerPortfolioRefresh(refresh);
    return () => registerPortfolioRefresh(undefined);
  }, [refresh, registerPortfolioRefresh]);

  const toDisplayCurrency = (valueCny: number) => valueCny / displayCurrency.cnyRate;
  const cnyMoney = (valueCny: number) => `${displayCurrency.symbol}${money(toDisplayCurrency(valueCny))}`;
  const signedCnyMoney = (valueCny: number) => `${valueCny >= 0 ? '+' : ''}${displayCurrency.symbol}${money(toDisplayCurrency(valueCny))}`;
  const localCurrency = (market: string) => market === 'US' ? '$' : market === 'HK' ? 'HK$' : '¥';
  const pnlClass = (value: number | null) => value === null ? 'portfolio-neutral' : value >= 0 ? 'market-up' : 'market-down';
  const setDisplayCurrency = async (currency: CurrencyType) => {
    await db.appSettings.put({ key: 'display_currency', value: currency, updatedAt: Date.now() });
    setCurrencyOpen(false);
  };

  return <div className="page tab-page portfolio-page">
    {contributions.length > 0 && <section className="joint-perspective-card" aria-label="合资账本视角"><span>查看视角</span><div><button type="button" className={!selectedPartner ? 'active' : ''} onClick={() => setSelectedPartner(null)}>整体</button>{contributions.map((item) => <button type="button" className={selectedPartner === item.name ? 'active' : ''} key={item.name} onClick={() => setSelectedPartner(item.name)}>{item.name} {Math.round(item.ratio * 1000) / 10}%</button>)}</div>{activeContribution && <small>{activeContribution.name}：净入金 {cnyMoney(activeContribution.netContributionCny)}，权益 {cnyMoney(activeContribution.assetsShareCny)}，累计盈亏 {signedCnyMoney(activeContribution.pnlShareCny)}</small>}</section>}
    <section className="portfolio-summary">
      <div className="portfolio-currency-selector">
        <button className="portfolio-currency-button" onClick={() => setCurrencyOpen((open) => !open)} aria-expanded={currencyOpen}>
          总资产（{displayCurrency.code}）<ChevronDown size={20} strokeWidth={2.5} aria-hidden="true" />
        </button>
        {currencyOpen && <div className="portfolio-currency-menu" role="menu">
          {Object.values(DisplayCurrency).map((currency) => <button key={currency.code} role="menuitem" className={currency.code === displayCurrency.code ? 'active' : ''} onClick={() => void setDisplayCurrency(currency.code)}>{currency.label}（{currency.code}）</button>)}
        </div>}
      </div>
      <div className="portfolio-total-assets">{cnyMoney(viewSnapshot.totalAssetsCny)}</div>
      <div className={pnlClass(viewSnapshot.dayProfitCny)}>今日盈亏 {signedCnyMoney(viewSnapshot.dayProfitCny)}（{viewSnapshot.dayProfitCny >= 0 ? '+' : ''}{viewSnapshot.dayProfitPercent.toFixed(2)}%）</div>
    </section>

    <section className="portfolio-metrics-card">
      <div className="portfolio-metrics-row">
        <Metric label="净入金" value={cnyMoney(viewSnapshot.netInflowCny)} details={[`累计入金 ${cnyMoney(viewSnapshot.totalDepositCny)}`, `累计出金 ${cnyMoney(viewSnapshot.totalWithdrawCny)}`]} />
        <Metric label="可用现金" value={cnyMoney(viewSnapshot.cashBalanceCny)} details={['按当前汇率估算']} />
      </div>
      <div className="portfolio-metrics-row">
        <Metric label="持仓浮盈" value={signedCnyMoney(viewSnapshot.unrealizedProfitCny)} className={pnlClass(viewSnapshot.unrealizedProfitCny)} details={[`${viewSnapshot.unrealizedProfitPercent >= 0 ? '+' : ''}${viewSnapshot.unrealizedProfitPercent.toFixed(2)}%`]} />
        <Metric label="持仓总市值" value={cnyMoney(viewSnapshot.holdingsValueCny)} details={['按现价估算']} />
      </div>
    </section>

    <section className="portfolio-metrics-card portfolio-trade-stats">
      <h2>交易统计</h2>
      <div className="portfolio-metrics-row">
        <Metric label="总手续费" value={cnyMoney(viewSnapshot.totalCommissionCny + viewSnapshot.totalTaxCny)} details={[`佣金 ${cnyMoney(viewSnapshot.totalCommissionCny)}`, `税费 ${cnyMoney(viewSnapshot.totalTaxCny)}`]} />
        <Metric label="交易次数" value={`${viewSnapshot.securityTradeCount} 次`} details={[`买入 ${viewSnapshot.buyTradeCount}`, `卖出 ${viewSnapshot.sellTradeCount}`]} />
      </div>
    </section>

    <section className="portfolio-holdings-section">
      <h2>持仓列表</h2>
      <div className="portfolio-holdings-card">
        {holdings.length === 0 ? <div className="portfolio-empty">当前范围内还没有持仓。<div className="empty-state-actions"><button type="button" onClick={() => navigate('/data/imports')}>导入结单</button><button type="button" className="primary" onClick={() => navigate('/transaction/new')}>手动记账</button></div></div> : holdings.map((item) => {
          const quote = quotes.find((q) => q.symbol === item.symbol && q.market === item.market);
          const hasQuote = quote?.currentPrice !== null && quote?.currentPrice !== undefined;
          const price = quote?.currentPrice ?? item.averageCost;
          const multiplier = item.assetType === 'OPTION' ? 100 : 1;
          const totalProfit = (price - item.averageCost) * item.quantity * multiplier;
          const totalProfitPercent = item.averageCost === 0 ? 0 : ((price - item.averageCost) / item.averageCost) * 100;
          const dayProfit = quote?.change === null || quote?.change === undefined ? null : quote.change * item.quantity * multiplier;
          const dayProfitPercent = quote?.changePercent ?? null;
          return <button key={`${item.market}:${item.symbol}`} className="portfolio-holding-row" onClick={() => navigate(securityDetailPath(item))}>
            <span className="portfolio-holding-main"><span className="portfolio-holding-title"><AdaptiveSingleLineText text={item.name || item.symbol} className="portfolio-holding-name" maxFontSize={16} />{item.assetType === 'OPTION' && <span className="portfolio-option-badge">期权</span>}</span><span>{item.symbol} · {item.market === 'US' ? '美股' : item.market === 'HK' ? '港股' : item.market === 'A_SHARE' ? 'A股' : '现金'} · {item.quantity} {item.assetType === 'OPTION' ? '张' : '股'} · {localCurrency(item.market)}{item.averageCost.toFixed(2)}</span></span>
            <span className="portfolio-holding-profit"><strong>{localCurrency(item.market)}{price.toFixed(2)}</strong><span className={pnlClass(dayProfit)}>当日 {dayProfit === null ? '—' : `${dayProfit >= 0 ? '+' : ''}${money(dayProfit)} (${dayProfitPercent === null ? '—' : `${dayProfitPercent >= 0 ? '+' : ''}${dayProfitPercent.toFixed(2)}%`})`}</span><span className={pnlClass(hasQuote ? totalProfit : null)}>持仓 {hasQuote ? `${totalProfit >= 0 ? '+' : ''}${money(totalProfit)} (${totalProfitPercent >= 0 ? '+' : ''}${totalProfitPercent.toFixed(2)}%)` : '—'}</span></span>
          </button>;
        })}
      </div>
    </section>
  </div>;
}

function Metric({ label, value, details, className }: { label: string; value: string; details: string[]; className?: string }) {
  return <div className="portfolio-metric"><span>{label}</span><strong className={className}>{value}</strong><span className="portfolio-metric-details">{details.map((detail) => <small key={detail}>{detail}</small>)}</span></div>;
}
