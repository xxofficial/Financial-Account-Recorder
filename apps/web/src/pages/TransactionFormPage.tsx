import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, Trash2 } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { TransactionRepository, AppSettingRepository } from '../db/repositories';
import { db } from '../db/localDb';
import { BrokerPlatform, DisplayCurrency, Market, TradeTypeLabels, isSecurityTrade, type CurrencyType, type MarketType, type PlatformType, type TradeType } from '../shared/models';
import { transactionSchema } from '../shared/schemas';
import { cacheService } from '../core/market/marketDataCacheService';
import { marketCacheManager } from '../core/market/marketCacheManager';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import { PlatformMark, useAppShell } from '../app/AppShell';

const txnRepo = new TransactionRepository();
const settingRepo = new AppSettingRepository();
const configurablePlatforms = Object.values(BrokerPlatform).filter((platform) => platform.isConfigurable);
const SECURITY_MARKETS: MarketType[] = ['A_SHARE', 'HK', 'US'];

function currencyMarket(currency: CurrencyType): MarketType {
  if (currency === 'USD') return 'US';
  if (currency === 'HKD') return 'HK';
  return 'CASH';
}

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function localTime() {
  return new Date().toTimeString().slice(0, 8);
}

function typeTone(type: TradeType) {
  if (['BUY', 'DEPOSIT', 'TRANSFER_IN', 'DIVIDEND', 'OTHER'].includes(type)) return 'positive';
  if (['SELL', 'WITHDRAW', 'TRANSFER_OUT', 'INTEREST', 'TAX'].includes(type)) return 'negative';
  return 'neutral';
}

function cashLabel(type: TradeType, currency: CurrencyType) {
  const label = DisplayCurrency[currency].label;
  if (type === 'DEPOSIT') return `入金金额 (${label})`;
  if (type === 'WITHDRAW') return `出金金额 (${label})`;
  if (type === 'INTEREST') return `利息金额 (${label})`;
  if (type === 'TAX') return `税费金额 (${label})`;
  if (type === 'DIVIDEND') return `分红金额 (${label})`;
  if (type === 'TRANSFER_IN') return `转入金额 (${label})`;
  if (type === 'TRANSFER_OUT') return `转出金额 (${label})`;
  return `其他金额 (${label})`;
}

function FieldBlock({
  label,
  value,
  onChange,
  placeholder = '请输入',
  type = 'text',
  step,
  supportingText,
  icon,
  readOnly = false,
  required = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  type?: string;
  step?: string;
  supportingText?: string;
  icon?: React.ReactNode;
  readOnly?: boolean;
  required?: boolean;
  multiline?: boolean;
}) {
  return <label className="trade-form-field">
    <span className="trade-form-label">{label}</span>
    <span className="trade-form-input-wrap">
      {multiline ? <textarea value={value} rows={3} placeholder={placeholder} readOnly={readOnly} required={required} onChange={(event) => onChange?.(event.target.value)} /> : <input value={value} type={type} step={step} placeholder={placeholder} readOnly={readOnly} required={required} onChange={(event) => onChange?.(event.target.value)} />}
      {icon}
    </span>
    {supportingText && <small className="trade-form-supporting">{supportingText}</small>}
  </label>;
}

function ChoiceGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return <section className="trade-form-choice-section">
    <span className="trade-form-label">{label}</span>
    <div className="trade-form-choice-row">
      {options.map((option) => <button type="button" key={option.value} className={`trade-form-choice ${value === option.value ? 'selected' : ''}`} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  </section>;
}

export default function TransactionFormPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { activePlatform, enabledPlatforms } = useAppShell();
  const isEdit = Boolean(id);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showPlatformMenu, setShowPlatformMenu] = useState(false);
  const [activeLedgerId, setActiveLedgerId] = useState(1);
  const [tradeType, setTradeType] = useState<TradeType>('BUY');
  const [market, setMarket] = useState<MarketType>('US');
  const [assetType, setAssetType] = useState<'STOCK' | 'OPTION'>('STOCK');
  const [platform, setPlatform] = useState<PlatformType>('LONGBRIDGE');
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [commission, setCommission] = useState('0');
  const [tax, setTax] = useState('0');
  const [tradeDate, setTradeDate] = useState(localDate);
  const [tradeTime, setTradeTime] = useState(localTime);
  const [note, setNote] = useState('');
  const [investorName, setInvestorName] = useState('');
  const [lookupMessage, setLookupMessage] = useState('');
  const [lookupState, setLookupState] = useState<'idle' | 'resolving' | 'resolved' | 'invalid'>('idle');
  const [underlying, setUnderlying] = useState('');
  const [optionType, setOptionType] = useState<'CALL' | 'PUT'>('CALL');
  const [strike, setStrike] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cashCurrency, setCashCurrency] = useState<CurrencyType>('CNY');
  const [fxFromCurrency, setFxFromCurrency] = useState('USD');
  const [fxFromAmount, setFxFromAmount] = useState('');
  const [fxToCurrency, setFxToCurrency] = useState('CNY');
  const [fxToAmount, setFxToAmount] = useState('');
  const [fxRate, setFxRate] = useState('');

  const ledger = useLiveQuery(() => db.ledgers.get(activeLedgerId), [activeLedgerId]);
  const ledgerTransactionsQuery = useLiveQuery(() => db.transactions.where('ledgerId').equals(activeLedgerId).toArray(), [activeLedgerId]);
  const quotesQuery = useLiveQuery(() => db.quoteSnapshots.toArray());
  const ledgerTransactions = useMemo(() => ledgerTransactionsQuery ?? [], [ledgerTransactionsQuery]);
  const quotes = useMemo(() => quotesQuery ?? [], [quotesQuery]);
  const availablePlatforms = useMemo(() => {
    const enabled = configurablePlatforms.filter((candidate) => enabledPlatforms.includes(candidate.code));
    return enabled.some((candidate) => candidate.code === platform) ? enabled : [...enabled, configurablePlatforms.find((candidate) => candidate.code === platform)].filter(Boolean) as typeof configurablePlatforms;
  }, [enabledPlatforms, platform]);
  const partners = useMemo(() => (ledger?.partners ?? '').split(',').map((item) => item.trim()).filter(Boolean), [ledger?.partners]);
  const isSecurity = isSecurityTrade(tradeType);

  const symbolSuggestions = useMemo(() => {
    if (!isSecurity || assetType === 'OPTION' || symbol.trim().length < 1) return [];
    const query = symbol.trim().toLowerCase();
    const items = new Map<string, { symbol: string; name: string; market: MarketType }>();
    [...quotes, ...ledgerTransactions.map((transaction) => ({ symbol: transaction.symbol, name: transaction.name, market: transaction.market }))]
      .filter((item) => item.market === market && item.market !== 'CASH' && (item.symbol.toLowerCase().includes(query) || item.name.toLowerCase().includes(query)))
      .forEach((item) => items.set(`${item.market}:${item.symbol}`, { symbol: item.symbol, name: item.name, market: item.market as MarketType }));
    return [...items.values()].slice(0, 5);
  }, [assetType, isSecurity, ledgerTransactions, market, quotes, symbol]);

  useEffect(() => {
    if (!isEdit && activePlatform && enabledPlatforms.includes(activePlatform)) setPlatform(activePlatform);
    else if (!isEdit && !enabledPlatforms.includes(platform)) setPlatform(enabledPlatforms[0] ?? 'LONGBRIDGE');
  }, [activePlatform, enabledPlatforms, isEdit, platform]);

  useEffect(() => {
    async function loadData() {
      try {
        const ledgerIdSetting = await settingRepo.get('default_ledger');
        const currentLedgerId = typeof ledgerIdSetting === 'number' && ledgerIdSetting > 0 ? ledgerIdSetting : 1;
        setActiveLedgerId(currentLedgerId);
        if (isEdit && id) {
          const txn = await txnRepo.get(Number(id));
          if (!txn) {
            window.alert('未找到该笔交易记录');
            navigate('/transactions');
            return;
          }
          setTradeType(txn.tradeType);
          setMarket(txn.market as MarketType);
          if (!isSecurityTrade(txn.tradeType)) setCashCurrency(txn.market === 'US' ? 'USD' : txn.market === 'HK' ? 'HKD' : 'CNY');
          setAssetType(txn.assetType || 'STOCK');
          setPlatform(txn.platform as PlatformType);
          setSymbol(txn.symbol);
          setName(txn.name);
          setPrice(String(txn.price));
          setQuantity(String(txn.quantity));
          setCommission(String(txn.commission));
          setTax(String(txn.tax));
          setTradeDate(txn.tradeDate);
          setTradeTime(txn.tradeTime || '10:00:00');
          setNote(txn.note || '');
          setInvestorName(txn.investorName || '');
          setUnderlying(txn.underlyingSymbol || '');
          setOptionType(txn.optionType || 'CALL');
          setStrike(txn.strikePrice == null ? '' : String(txn.strikePrice));
          setExpiry(txn.expiryDate || '');
          setFxFromCurrency(txn.fxFromCurrency || 'USD');
          setFxFromAmount(txn.fxFromAmount == null ? '' : String(txn.fxFromAmount));
          setFxToCurrency(txn.fxToCurrency || 'CNY');
          setFxToAmount(txn.fxToAmount == null ? '' : String(txn.fxToAmount));
          setFxRate(txn.fxRate == null ? '' : String(txn.fxRate));
        } else {
          const requestedType = searchParams.get('type') as TradeType | null;
          if (requestedType && requestedType in TradeTypeLabels) setTradeType(requestedType);
        }
      } catch (error) {
        console.error('加载交易表单数据失败', error);
      } finally {
        setLoading(false);
      }
    }
    void loadData();
  }, [id, isEdit, navigate, searchParams]);

  useEffect(() => {
    if (!isSecurity || assetType === 'OPTION' || !symbol.trim()) {
      setLookupState('idle');
      setLookupMessage('');
      return;
    }
    let cancelled = false;
    setLookupState('resolving');
    const timer = window.setTimeout(() => {
      void cacheService.resolveSecurityName(symbol.trim().toUpperCase(), market).then((resolvedName) => {
        if (cancelled) return;
        if (resolvedName) {
          setName(resolvedName);
          setLookupState('resolved');
          setLookupMessage(`已识别：${resolvedName}`);
        } else {
          setLookupState('invalid');
          setLookupMessage('未找到本地或已配置行情源中的证券');
        }
      }).catch(() => {
        if (!cancelled) {
          setLookupState('invalid');
          setLookupMessage('证券名称暂时无法解析，可继续手动填写');
        }
      });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [assetType, isSecurity, market, symbol]);

  useEffect(() => {
    if (isSecurity) {
      if (market === 'CASH') setMarket('US');
      return;
    }
    if (market !== 'CASH') setMarket('CASH');
    setAssetType('STOCK');
  }, [isSecurity, market]);

  const selectSuggestion = (suggestion: { symbol: string; name: string; market: MarketType }) => {
    setSymbol(suggestion.symbol);
    setName(suggestion.name);
    setMarket(suggestion.market);
    setLookupState('resolved');
    setLookupMessage(`已选择：${suggestion.name}`);
  };

  const handleDelete = async () => {
    if (!isEdit || !id || !window.confirm('确认删除这条记录吗？删除后无法恢复。')) return;
    await txnRepo.delete(Number(id));
    navigate('/transactions');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const optionSymbol = `${underlying.trim().toUpperCase()} ${expiry.replace(/-/g, '').substring(2)}${optionType.charAt(0)}${strike}`;
    const computedSymbol = isSecurity ? (assetType === 'OPTION' ? optionSymbol : symbol.trim().toUpperCase()) : (tradeType === 'FX_CONVERSION' ? 'FX' : 'CASH');
    const computedName = isSecurity ? (assetType === 'OPTION' ? `${underlying.trim().toUpperCase()} ${expiry} ${optionType === 'CALL' ? 'CALL' : 'PUT'} $${strike}` : name.trim() || symbol.trim().toUpperCase()) : (tradeType === 'FX_CONVERSION' ? '外汇兑换' : tradeType === 'DEPOSIT' ? '现金' : TradeTypeLabels[tradeType]);
    const parsedData = {
      ledgerId: activeLedgerId,
      tradeType,
      platform,
      market: isSecurity ? market : currencyMarket(cashCurrency),
      symbol: computedSymbol,
      name: computedName,
      tradeDate,
      tradeTime: tradeTime.length === 5 ? `${tradeTime}:00` : tradeTime,
      price: Number(price) || 0,
      quantity: isSecurity ? (Number(quantity) || 0) : 1,
      commission: isSecurity ? (Number(commission) || 0) : 0,
      tax: isSecurity ? (Number(tax) || 0) : 0,
      note: note.trim(),
      investorName: investorName || null,
      sourceChannel: null,
      externalReference: null,
      assetType: isSecurity && (market === 'US' || market === 'HK') ? assetType : 'STOCK',
      underlyingSymbol: isSecurity && assetType === 'OPTION' ? underlying.trim().toUpperCase() : null,
      expiryDate: isSecurity && assetType === 'OPTION' ? expiry : null,
      strikePrice: isSecurity && assetType === 'OPTION' ? Number(strike) || null : null,
      optionType: isSecurity && assetType === 'OPTION' ? optionType : null,
      fxFromCurrency: tradeType === 'FX_CONVERSION' ? fxFromCurrency : null,
      fxFromAmount: tradeType === 'FX_CONVERSION' ? Number(fxFromAmount) || null : null,
      fxToCurrency: tradeType === 'FX_CONVERSION' ? fxToCurrency : null,
      fxToAmount: tradeType === 'FX_CONVERSION' ? Number(fxToAmount) || null : null,
      fxRate: tradeType === 'FX_CONVERSION' ? Number(fxRate) || null : null,
    };
    const result = transactionSchema.safeParse(parsedData);
    if (!result.success) {
      window.alert(`请检查表单：\n${result.error.issues.map((issue) => issue.message).join('\n')}`);
      return;
    }
    const payload = {
      ...result.data,
      sourceChannel: parsedData.sourceChannel,
      externalReference: parsedData.externalReference,
      investorName: result.data.investorName ?? null,
      underlyingSymbol: result.data.underlyingSymbol ?? null,
      expiryDate: result.data.expiryDate ?? null,
      strikePrice: result.data.strikePrice ?? null,
      optionType: result.data.optionType ?? null,
      fxFromCurrency: result.data.fxFromCurrency ?? null,
      fxFromAmount: result.data.fxFromAmount ?? null,
      fxToCurrency: result.data.fxToCurrency ?? null,
      fxToAmount: result.data.fxToAmount ?? null,
      fxRate: result.data.fxRate ?? null,
    };
    setSaving(true);
    try {
      if (isEdit && id) await txnRepo.update(Number(id), payload);
      else await txnRepo.create(payload);
      if (await settingRepo.get('auto_sync_after_transaction')) {
        await marketCacheManager.detectAndQueueMissingRanges();
        await MarketTaskExecutor.startOrWakeMarketExecutor();
      }
      navigate('/transactions');
    } catch (error) {
      console.error('保存交易失败', error);
      window.alert('保存失败，请检查输入或重试');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="trade-form-loading">加载中...</div>;

  const typeLabel = isEdit ? '编辑记录' : '录入交易';
  const tone = typeTone(tradeType);
  const securityIdentifier = assetType === 'OPTION' ? underlying : symbol;
  const canSubmit = Boolean(tradeDate && tradeTime && (isSecurity ? securityIdentifier.trim() && price && quantity : price) && (assetType !== 'OPTION' || (underlying && expiry && strike)) && lookupState !== 'invalid');

  return <div className="trade-form-page">
    <header className="trade-form-header">
      <button type="button" className="trade-form-back" onClick={() => navigate('/transactions')} aria-label="返回流水"><ArrowLeft size={22} /></button>
      <h1>{typeLabel}</h1>
      {isEdit ? <button type="button" className="trade-form-delete" onClick={() => void handleDelete()} aria-label="删除记录"><Trash2 size={21} /></button> : <span className="trade-form-header-spacer" />}
    </header>

    <form className="trade-form-scroll" onSubmit={(event) => void handleSubmit(event)}>
      <section className="trade-form-section">
        <span className="trade-form-label">交易类型</span>
        <div className={`trade-type-badge ${tone}`}>{TradeTypeLabels[tradeType]}</div>
      </section>

      <section className="trade-platform-section">
        <span className="trade-form-label">交易平台</span>
        <button type="button" className="trade-platform-trigger" onClick={() => setShowPlatformMenu((open) => !open)}><PlatformMark platform={platform} /><span>{BrokerPlatform[platform]?.label ?? platform}</span><ChevronDown size={20} className={showPlatformMenu ? 'open' : ''} /></button>
        {showPlatformMenu && <div className="trade-platform-options">
          {availablePlatforms.map((item) => <button type="button" key={item.code} className={`trade-platform-option ${platform === item.code ? 'selected' : ''}`} onClick={() => { setPlatform(item.code); setShowPlatformMenu(false); }}><PlatformMark platform={item.code} /><span>{item.label}</span>{platform === item.code && <span className="trade-platform-check">当前</span>}</button>)}
        </div>}
      </section>

      {isSecurity ? <>
        <ChoiceGroup label="市场" value={market} onChange={(value) => setMarket(value as MarketType)} options={SECURITY_MARKETS.map((value) => ({ value, label: Market[value].label }))} />
        {(market === 'US' || market === 'HK') && <ChoiceGroup label="资产类型" value={assetType} onChange={(value) => setAssetType(value as 'STOCK' | 'OPTION')} options={[{ value: 'STOCK', label: '股票' }, { value: 'OPTION', label: '期权' }]} />}
        {assetType === 'OPTION' && (market === 'US' || market === 'HK') ? <>
          <FieldBlock label="正股代码" value={underlying} onChange={(value) => setUnderlying(value.toUpperCase())} supportingText={lookupMessage} required />
          <div className="trade-form-grid">
            <FieldBlock label="到期日" value={expiry} onChange={setExpiry} type="date" required />
            <FieldBlock label="行权价" value={strike} onChange={setStrike} type="number" step="0.0001" required />
          </div>
          <ChoiceGroup label="期权类型" value={optionType} onChange={(value) => setOptionType(value as 'CALL' | 'PUT')} options={[{ value: 'CALL', label: '看涨 Call' }, { value: 'PUT', label: '看跌 Put' }]} />
        </> : <>
          <FieldBlock label="证券代码 / 名称" value={symbol} onChange={(value) => setSymbol(value.toUpperCase())} supportingText={lookupMessage} required />
          {symbolSuggestions.length > 0 && <section className="trade-suggestion-card"><span className="trade-form-label">候选证券</span>{symbolSuggestions.map((suggestion) => <button type="button" key={`${suggestion.market}:${suggestion.symbol}`} onClick={() => selectSuggestion(suggestion)}><span><strong>{suggestion.name}</strong><small>{suggestion.symbol} · {Market[suggestion.market].label}</small></span><ChevronDown size={18} /></button>)}</section>}
        </>}
        <div className="trade-form-grid">
          <FieldBlock label={tradeType === 'SPLIT' ? '折算比例' : '成交价格'} value={price} onChange={(value) => { setPrice(value); if (tradeType === 'SPLIT') setQuantity('1'); }} type="number" step="0.0001" required />
          {tradeType !== 'SPLIT' && <FieldBlock label={tradeType === 'EXPIRE' ? '过期数量' : '成交数量'} value={quantity} onChange={(value) => { setQuantity(value); if (tradeType === 'EXPIRE') setPrice('0'); }} type="number" step="0.0001" required />}
        </div>
        {tradeType !== 'SPLIT' && <section className="trade-fee-card"><div className="trade-fee-heading"><span>手续费 / 税费</span><button type="button" className="trade-fee-estimate" disabled title="自动费用估算待实现">自动估算（待实现）</button></div><div className="trade-form-grid"><FieldBlock label="佣金" value={commission} onChange={setCommission} type="number" step="0.01" /><FieldBlock label="税费" value={tax} onChange={setTax} type="number" step="0.01" /></div></section>}
      </> : <>
        {ledger?.type === 'JOINT' && (tradeType === 'DEPOSIT' || tradeType === 'WITHDRAW') && partners.length > 0 && <ChoiceGroup label={tradeType === 'DEPOSIT' ? '出资人（入金人）' : '撤资人（出金人）'} value={investorName || partners[0]} onChange={setInvestorName} options={partners.map((partner) => ({ value: partner, label: partner }))} />}
        <ChoiceGroup label="货币种类" value={cashCurrency} onChange={(value) => setCashCurrency(value as CurrencyType)} options={Object.values(DisplayCurrency).map((currency) => ({ value: currency.code, label: currency.label }))} />
        <FieldBlock label={cashLabel(tradeType, cashCurrency)} value={price} onChange={(value) => { setPrice(value); setQuantity('1'); }} type="number" step="0.01" supportingText={`当前按${DisplayCurrency[cashCurrency].label}录入，保存后自动折算到资产汇总。`} required />
        {tradeType === 'FX_CONVERSION' && <section className="trade-fee-card"><div className="trade-fee-heading">兑换详情</div><div className="trade-form-grid"><FieldBlock label="源货币" value={fxFromCurrency} onChange={setFxFromCurrency} /><FieldBlock label="源金额" value={fxFromAmount} onChange={setFxFromAmount} type="number" step="0.01" /><FieldBlock label="目标货币" value={fxToCurrency} onChange={setFxToCurrency} /><FieldBlock label="目标金额" value={fxToAmount} onChange={setFxToAmount} type="number" step="0.01" /></div><FieldBlock label="汇率" value={fxRate} onChange={setFxRate} type="number" step="0.00001" /></section>}
      </>}

      <div className="trade-form-grid">
        <FieldBlock label="交易日期" value={tradeDate} onChange={setTradeDate} type="date" required />
        <FieldBlock label="交易时间" value={tradeTime.slice(0, 5)} onChange={setTradeTime} type="time" required />
      </div>
      <FieldBlock label="备注" value={note} onChange={setNote} placeholder="记下这笔交易的心得或额外细节" multiline />
    </form>
    <div className="trade-form-actions"><button type="button" onClick={() => navigate('/transactions')}>取消</button><button type="submit" className="primary" disabled={!canSubmit || saving} onClick={(event) => { const form = (event.currentTarget.closest('.trade-form-page')?.querySelector('form') as HTMLFormElement | null); form?.requestSubmit(); }}>{saving ? '保存中…' : isEdit ? '保存修改' : `确认${TradeTypeLabels[tradeType]}`}</button></div>
  </div>;
}
