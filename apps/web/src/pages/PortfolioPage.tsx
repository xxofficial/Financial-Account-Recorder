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

const calculator = new PortfolioCalculator();
const rates: ExchangeRates = { usdToCny: 7.2, hkdToCny: .92 };
const EMPTY: never[] = [];
const money = (value: number) => value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PortfolioPage() {
  const navigate = useNavigate();
  const { registerPortfolioRefresh, activePlatform } = useAppShell();
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const selectedLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value) ?? 1;
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
  const holdings = useMemo(() => Object.values(snapshot.positions).filter((item) => Math.abs(item.quantity) > 1e-5), [snapshot]);
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
    <section className="portfolio-summary">
      <div className="portfolio-currency-selector">
        <button className="portfolio-currency-button" onClick={() => setCurrencyOpen((open) => !open)} aria-expanded={currencyOpen}>
          总资产（{displayCurrency.code}）<ChevronDown size={20} strokeWidth={2.5} aria-hidden="true" />
        </button>
        {currencyOpen && <div className="portfolio-currency-menu" role="menu">
          {Object.values(DisplayCurrency).map((currency) => <button key={currency.code} role="menuitem" className={currency.code === displayCurrency.code ? 'active' : ''} onClick={() => void setDisplayCurrency(currency.code)}>{currency.label}（{currency.code}）</button>)}
        </div>}
      </div>
      <div className="portfolio-total-assets">{cnyMoney(snapshot.totalAssetsCny)}</div>
      <div className={pnlClass(snapshot.dayProfitCny)}>今日盈亏 {signedCnyMoney(snapshot.dayProfitCny)}（{snapshot.dayProfitCny >= 0 ? '+' : ''}{snapshot.dayProfitPercent.toFixed(2)}%）</div>
    </section>

    <section className="portfolio-metrics-card">
      <div className="portfolio-metrics-row">
        <Metric label="净入金" value={cnyMoney(snapshot.netInflowCny)} details={[`累计入金 ${cnyMoney(snapshot.totalDepositCny)}`, `累计出金 ${cnyMoney(snapshot.totalWithdrawCny)}`]} />
        <Metric label="可用现金" value={cnyMoney(snapshot.cashBalanceCny)} details={['按当前汇率估算']} />
      </div>
      <div className="portfolio-metrics-row">
        <Metric label="持仓浮盈" value={signedCnyMoney(snapshot.unrealizedProfitCny)} className={pnlClass(snapshot.unrealizedProfitCny)} details={[`${snapshot.unrealizedProfitPercent >= 0 ? '+' : ''}${snapshot.unrealizedProfitPercent.toFixed(2)}%`]} />
        <Metric label="持仓总市值" value={cnyMoney(snapshot.holdingsValueCny)} details={['按现价估算']} />
      </div>
    </section>

    <section className="portfolio-metrics-card portfolio-trade-stats">
      <h2>交易统计</h2>
      <div className="portfolio-metrics-row">
        <Metric label="总手续费" value={cnyMoney(snapshot.totalCommissionCny + snapshot.totalTaxCny)} details={[`佣金 ${cnyMoney(snapshot.totalCommissionCny)}`, `税费 ${cnyMoney(snapshot.totalTaxCny)}`]} />
        <Metric label="交易次数" value={`${snapshot.securityTradeCount} 次`} details={[`买入 ${snapshot.buyTradeCount}`, `卖出 ${snapshot.sellTradeCount}`]} />
      </div>
    </section>

    <section className="portfolio-holdings-section">
      <h2>持仓列表</h2>
      <div className="portfolio-holdings-card">
        {holdings.length === 0 ? <div className="portfolio-empty">当前范围内还没有持仓。</div> : holdings.map((item) => {
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
