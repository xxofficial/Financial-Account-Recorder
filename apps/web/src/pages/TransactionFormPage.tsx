import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, Trash2 } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { TransactionRepository, AppSettingRepository } from '../db/repositories';
import { db } from '../db/localDb';
import { BrokerPlatform, DisplayCurrency, Market, TradeTypeLabels, isSecurityTrade, type CurrencyType, type MarketType, type PlatformType, type TradeType } from '../shared/models';
import { transactionSchema } from '../shared/schemas';
import { cacheService, rankSecuritySuggestions, type SecuritySuggestion } from '../core/market/marketDataCacheService';
import { marketCacheManager } from '../core/market/marketCacheManager';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import { createTransferPair, deleteTransferPairByTransactionId, getTransferPairByTransactionId, TransferValidationError, updateTransferPair } from '../core/transfers/transferService';
import { estimateTradeFees } from '../core/fees/tradeFeeEstimator';
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
  if (type === 'INTEREST') return `融资利息金额 (${label})`;
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

function SecurityAutocompleteField({
  label,
  value,
  onChange,
  suggestions,
  onSelect,
  supportingText,
  optionUnderlying = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: SecuritySuggestion[];
  onSelect: (suggestion: SecuritySuggestion) => void;
  supportingText?: string;
  optionUnderlying?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => setActiveIndex(0), [value, suggestions.length]);
  const select = (suggestion: SecuritySuggestion) => { onSelect(suggestion); setOpen(false); };
  return <div className="trade-security-autocomplete">
    <label className="trade-form-field">
      <span className="trade-form-label">{label}</span>
      <span className="trade-form-input-wrap">
        <input
          value={value}
          placeholder={optionUnderlying ? '输入正股代码或名称' : '输入证券代码或名称'}
          required
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && suggestions.length > 0}
          aria-controls="security-suggestion-list"
          aria-activedescendant={open && suggestions[activeIndex] ? `security-suggestion-${suggestions[activeIndex].market}-${suggestions[activeIndex].symbol}` : undefined}
          onFocus={() => setOpen(true)}
          onChange={(event) => { onChange(event.target.value); setOpen(true); }}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (!suggestions.length) return;
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(suggestions.length - 1, index + 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.max(0, index - 1)); }
            else if (event.key === 'Enter' && open && suggestions[activeIndex]) { event.preventDefault(); select(suggestions[activeIndex]); }
            else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
          }}
        />
      </span>
      {supportingText && <small className="trade-form-supporting">{supportingText}</small>}
    </label>
    {open && value.trim() && suggestions.length > 0 && <section id="security-suggestion-list" className="trade-suggestion-card" role="listbox" aria-label="候选证券">
      <span className="trade-form-label">候选证券</span>
      {suggestions.map((suggestion, index) => <button type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} id={`security-suggestion-${suggestion.market}-${suggestion.symbol}`} key={`${suggestion.market}:${suggestion.symbol}`} onMouseDown={(event) => event.preventDefault()} onClick={() => select(suggestion)}>
        <span><strong>{suggestion.name}</strong><small>{suggestion.symbol} · {Market[suggestion.market as MarketType].label}</small></span><ChevronDown size={18} />
      </button>)}
    </section>}
  </div>;
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
  const [estimatingFees, setEstimatingFees] = useState(false);
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
  const [pairedTransfer, setPairedTransfer] = useState(searchParams.get('paired') === '1');
  const [transferKind, setTransferKind] = useState<'CASH' | 'SECURITY'>('CASH');
  const [transferTargetPlatform, setTransferTargetPlatform] = useState<PlatformType>('SCHWAB');
  const [transferGroupId, setTransferGroupId] = useState<string | null>(null);

  const ledger = useLiveQuery(() => db.ledgers.get(activeLedgerId), [activeLedgerId]);
  const ledgerTransactionsQuery = useLiveQuery(() => db.transactions.where('ledgerId').equals(activeLedgerId).toArray(), [activeLedgerId]);
  const quotesQuery = useLiveQuery(() => db.quoteSnapshots.toArray());
  const ledgerTransactions = useMemo(() => ledgerTransactionsQuery ?? [], [ledgerTransactionsQuery]);
  const quotes = useMemo(() => quotesQuery ?? [], [quotesQuery]);
  const availablePlatforms = useMemo(() => {
    const enabled = configurablePlatforms.filter((candidate) => enabledPlatforms.includes(candidate.code));
    return enabled.some((candidate) => candidate.code === platform) ? enabled : [...enabled, configurablePlatforms.find((candidate) => candidate.code === platform)].filter(Boolean) as typeof configurablePlatforms;
  }, [enabledPlatforms, platform]);
  const transferPlatformOptions = useMemo(() => configurablePlatforms.filter((candidate) => candidate.code !== platform), [platform]);
  const partners = useMemo(() => (ledger?.partners ?? '').split(',').map((item) => item.trim()).filter(Boolean), [ledger?.partners]);
  const isTransfer = tradeType === 'TRANSFER_OUT' || tradeType === 'TRANSFER_IN';
  const isSecurity = isSecurityTrade(tradeType) || (pairedTransfer && isTransfer && transferKind === 'SECURITY');

  const lookupIdentifier = assetType === 'OPTION' ? underlying : symbol;
  const localSuggestions = useMemo(() => {
    if (!isSecurity || !lookupIdentifier.trim() || market === 'CASH') return [];
    return rankSecuritySuggestions(lookupIdentifier, [
      ...quotes.filter((quote) => quote.market === market && quote.assetType === 'STOCK').map((quote) => ({ symbol: quote.symbol, name: quote.name || quote.symbol, market: quote.market, assetType: 'STOCK' as const })),
      ...ledgerTransactions.filter((transaction) => transaction.market === market && transaction.assetType === 'STOCK' && transaction.symbol).map((transaction) => ({ symbol: transaction.symbol, name: transaction.name || transaction.symbol, market: transaction.market, assetType: 'STOCK' as const })),
    ]);
  }, [isSecurity, ledgerTransactions, lookupIdentifier, market, quotes]);
  const [remoteSuggestions, setRemoteSuggestions] = useState<SecuritySuggestion[]>([]);
  const securitySuggestions = useMemo(() => rankSecuritySuggestions(lookupIdentifier, [...localSuggestions, ...remoteSuggestions]), [localSuggestions, lookupIdentifier, remoteSuggestions]);

  useEffect(() => {
    if (!isEdit && activePlatform && enabledPlatforms.includes(activePlatform)) setPlatform(activePlatform);
    else if (!isEdit && !enabledPlatforms.includes(platform)) setPlatform(enabledPlatforms[0] ?? 'LONGBRIDGE');
  }, [activePlatform, enabledPlatforms, isEdit, platform]);

  useEffect(() => {
    if (pairedTransfer && isTransfer && transferTargetPlatform === platform) {
      setTransferTargetPlatform((transferPlatformOptions[0]?.code ?? 'SCHWAB') as PlatformType);
    }
  }, [isTransfer, pairedTransfer, platform, transferPlatformOptions, transferTargetPlatform]);

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
          const pair = txn.id && txn.transferGroupId ? await getTransferPairByTransactionId(txn.id) : null;
          const source = pair?.out ?? txn;
          const destination = pair?.in;
          const isPaired = Boolean(pair);
          setPairedTransfer(isPaired);
          setTransferGroupId(pair?.groupId ?? null);
          setTradeType(isPaired ? 'TRANSFER_OUT' : txn.tradeType);
          setTransferKind(isPaired && source.symbol === 'CASH' ? 'CASH' : 'SECURITY');
          setMarket(source.market as MarketType);
          if (!isSecurityTrade(source.tradeType) && !isPaired) setCashCurrency(source.market === 'US' ? 'USD' : source.market === 'HK' ? 'HKD' : 'CNY');
          if (isPaired && source.symbol === 'CASH') setCashCurrency(source.market === 'US' ? 'USD' : source.market === 'HK' ? 'HKD' : 'CNY');
          setAssetType(source.assetType || 'STOCK');
          setPlatform(source.platform as PlatformType);
          setTransferTargetPlatform((destination?.platform ?? source.transferCounterpartyPlatform ?? 'SCHWAB') as PlatformType);
          setSymbol(source.symbol);
          setName(source.name);
          setPrice(String(source.price));
          setQuantity(String(source.quantity));
          setCommission(String(source.commission));
          setTax(String(source.tax));
          setTradeDate(source.tradeDate);
          setTradeTime(source.tradeTime || '10:00:00');
          setNote(source.note || '');
          setInvestorName(source.investorName || '');
          setUnderlying(source.underlyingSymbol || '');
          setOptionType(source.optionType || 'CALL');
          setStrike(source.strikePrice == null ? '' : String(source.strikePrice));
          setExpiry(source.expiryDate || '');
          setFxFromCurrency(source.fxFromCurrency || 'USD');
          setFxFromAmount(source.fxFromAmount == null ? '' : String(source.fxFromAmount));
          setFxToCurrency(source.fxToCurrency || 'CNY');
          setFxToAmount(source.fxToAmount == null ? '' : String(source.fxToAmount));
          setFxRate(source.fxRate == null ? '' : String(source.fxRate));
        } else {
          const requestedType = searchParams.get('type') as TradeType | null;
          if (requestedType && requestedType in TradeTypeLabels) setTradeType(requestedType);
          if (requestedType === 'TRANSFER_OUT') setPairedTransfer(searchParams.get('paired') === '1');
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
    const query = lookupIdentifier.trim();
    setRemoteSuggestions([]);
    if (!isSecurity || !query || market === 'CASH') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void cacheService.suggestSecurities(query, market).then((items) => {
        if (!cancelled) setRemoteSuggestions(items);
      }).catch(() => {
        if (!cancelled) setRemoteSuggestions([]);
      });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [isSecurity, lookupIdentifier, market]);

  useEffect(() => {
    if (isSecurity) {
      if (market === 'CASH') setMarket('US');
      return;
    }
    if (market !== 'CASH') setMarket('CASH');
    setAssetType('STOCK');
  }, [isSecurity, market]);

  const selectSuggestion = (suggestion: SecuritySuggestion) => {
    setSymbol(suggestion.symbol);
    setName(suggestion.name);
    setMarket(suggestion.market as MarketType);
    setLookupMessage(`已选择：${suggestion.name}`);
  };

  const selectUnderlyingSuggestion = (suggestion: SecuritySuggestion) => {
    setUnderlying(suggestion.symbol);
    setLookupMessage(`已选择正股：${suggestion.name}（${suggestion.symbol}）`);
  };

  const estimateFees = async () => {
    if (estimatingFees) return;
    setEstimatingFees(true);
    try {
      const selections = await settingRepo.get('platform_fee_plan_selections') as Record<string, string> | undefined;
      const estimate = estimateTradeFees({
        platform,
        planId: selections?.[platform],
        market,
        assetType,
        tradeType,
        price: Number(price),
        quantity: Number(quantity),
        tradeDate,
        transactions: ledgerTransactions,
      });
      if (!estimate.supported) {
        window.alert(estimate.warnings.join('\n'));
        return;
      }
      const detail = estimate.lines.length ? estimate.lines.map((line) => `${line.label}: ${line.amount.toFixed(2)}`).join('\n') : '佣金 / 平台费：0.00';
      const warning = estimate.warnings.length ? `\n\n提示：${estimate.warnings.join(' ')}` : '';
      const rule = estimate.ruleId ? `\n规则版本：${estimate.ruleId}` : '';
      if (window.confirm(`${detail}\n\n佣金/平台费合计：${estimate.commission.toFixed(2)}\n税费合计：${estimate.tax.toFixed(2)}${rule}${warning}\n\n确认回填到表单？`)) {
        setCommission(estimate.commission.toFixed(2));
        setTax(estimate.tax.toFixed(2));
      }
    } finally {
      setEstimatingFees(false);
    }
  };

  const handleDelete = async () => {
    if (!isEdit || !id || !window.confirm('确认删除这条记录吗？删除后无法恢复。')) return;
    try {
      if (pairedTransfer && transferGroupId) await deleteTransferPairByTransactionId(Number(id));
      else await txnRepo.delete(Number(id));
      navigate('/transactions');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '删除失败，请重试。');
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (pairedTransfer && isTransfer) {
        const isSecurityTransfer = transferKind === 'SECURITY';
        const optionSymbol = `${underlying.trim().toUpperCase()} ${expiry.replace(/-/g, '').substring(2)}${optionType.charAt(0)}${strike}`;
        const transferSymbol = isSecurityTransfer ? (assetType === 'OPTION' ? optionSymbol : symbol.trim().toUpperCase()) : 'CASH';
        const transferName = isSecurityTransfer
          ? (assetType === 'OPTION' ? `${underlying.trim().toUpperCase()} ${expiry} ${optionType === 'CALL' ? 'CALL' : 'PUT'} $${strike}` : name.trim() || transferSymbol)
          : '现金';
        const draft = {
          ledgerId: activeLedgerId,
          sourcePlatform: platform,
          targetPlatform: transferTargetPlatform,
          market: isSecurityTransfer ? market : currencyMarket(cashCurrency),
          symbol: transferSymbol,
          name: transferName,
          tradeDate,
          tradeTime: tradeTime.length === 5 ? `${tradeTime}:00` : tradeTime,
          isSecurity: isSecurityTransfer,
          quantity: isSecurityTransfer ? Number(quantity) || 0 : 1,
          amount: isSecurityTransfer ? undefined : Number(price) || 0,
          assetType: isSecurityTransfer ? assetType : 'STOCK',
          underlyingSymbol: isSecurityTransfer && assetType === 'OPTION' ? underlying.trim().toUpperCase() : null,
          expiryDate: isSecurityTransfer && assetType === 'OPTION' ? expiry : null,
          strikePrice: isSecurityTransfer && assetType === 'OPTION' ? Number(strike) || null : null,
          optionType: isSecurityTransfer && assetType === 'OPTION' ? optionType : null,
          commission: Number(commission) || 0,
          tax: Number(tax) || 0,
          note: note.trim(),
        } as const;
        if (transferGroupId) await updateTransferPair(transferGroupId, draft);
        else await createTransferPair(draft);
      } else {
    const optionSymbol = `${underlying.trim().toUpperCase()} ${expiry.replace(/-/g, '').substring(2)}${optionType.charAt(0)}${strike}`;
    const computedSymbol = isSecurity ? (assetType === 'OPTION' ? optionSymbol : symbol.trim().toUpperCase()) : (tradeType === 'FX_CONVERSION' ? 'FX' : 'CASH');
    const resolvedName = isSecurity && assetType !== 'OPTION' && symbol.trim()
      ? await cacheService.resolveSecurityName(symbol.trim().toUpperCase(), market).catch(() => null)
      : null;
    const computedName = isSecurity ? (assetType === 'OPTION' ? `${underlying.trim().toUpperCase()} ${expiry} ${optionType === 'CALL' ? 'CALL' : 'PUT'} $${strike}` : resolvedName || name.trim() || symbol.trim().toUpperCase()) : (tradeType === 'FX_CONVERSION' ? '外汇兑换' : tradeType === 'DEPOSIT' ? '现金' : TradeTypeLabels[tradeType]);
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
       transferGroupId: null,
       transferCounterpartyPlatform: null,
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
       transferGroupId: null,
       transferCounterpartyPlatform: null,
     };
      if (isEdit && id) await txnRepo.update(Number(id), payload);
      else await txnRepo.create(payload);
      }
      // Missing settings use the product default: queue a repair after a transaction.
      // A user can still explicitly opt out by saving `false` in Settings.
      if ((await settingRepo.get('auto_sync_after_transaction')) !== false) {
        await marketCacheManager.detectAndQueueMissingRanges();
        await MarketTaskExecutor.startOrWakeMarketExecutor();
      }
      navigate('/transactions');
    } catch (error) {
      console.error('保存交易失败', error);
      window.alert(error instanceof TransferValidationError ? error.message : '保存失败，请检查输入或重试');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="trade-form-loading">加载中...</div>;

  const typeLabel = isEdit ? '编辑记录' : '录入交易';
  const tone = typeTone(tradeType);
  const securityIdentifier = assetType === 'OPTION' ? underlying : symbol;
  const canSubmit = pairedTransfer && isTransfer
    ? Boolean(tradeDate && tradeTime && transferTargetPlatform !== platform && (transferKind === 'SECURITY'
      ? securityIdentifier.trim() && quantity && (assetType !== 'OPTION' || (underlying && expiry && strike))
      : price))
    : Boolean(tradeDate && tradeTime && (isSecurity ? securityIdentifier.trim() && price && quantity : price) && (assetType !== 'OPTION' || (underlying && expiry && strike)));

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

      {pairedTransfer && isTransfer ? <>
        <ChoiceGroup label="转仓类型" value={transferKind} onChange={(value) => setTransferKind(value as 'CASH' | 'SECURITY')} options={[{ value: 'CASH', label: '现金' }, { value: 'SECURITY', label: '证券' }]} />
        <ChoiceGroup label="目标平台" value={transferTargetPlatform} onChange={(value) => setTransferTargetPlatform(value as PlatformType)} options={transferPlatformOptions.map((item) => ({ value: item.code, label: item.label }))} />
        {transferKind === 'SECURITY' ? <>
          <ChoiceGroup label="市场" value={market} onChange={(value) => setMarket(value as MarketType)} options={SECURITY_MARKETS.map((value) => ({ value, label: Market[value].label }))} />
          {(market === 'US' || market === 'HK') && <ChoiceGroup label="资产类型" value={assetType} onChange={(value) => setAssetType(value as 'STOCK' | 'OPTION')} options={[{ value: 'STOCK', label: '股票' }, { value: 'OPTION', label: '期权' }]} />}
          {assetType === 'OPTION' && (market === 'US' || market === 'HK') ? <>
            <SecurityAutocompleteField label="正股代码" value={underlying} onChange={(value) => { setUnderlying(value.toUpperCase()); setLookupMessage(''); }} suggestions={securitySuggestions} onSelect={selectUnderlyingSuggestion} supportingText={lookupMessage || (securitySuggestions.length ? `找到 ${securitySuggestions.length} 条候选，点一下可自动补全` : '')} optionUnderlying />
            <div className="trade-form-grid">
              <FieldBlock label="到期日" value={expiry} onChange={setExpiry} type="date" required />
              <FieldBlock label="行权价" value={strike} onChange={setStrike} type="number" step="0.0001" required />
            </div>
            <ChoiceGroup label="期权类型" value={optionType} onChange={(value) => setOptionType(value as 'CALL' | 'PUT')} options={[{ value: 'CALL', label: '看涨 Call' }, { value: 'PUT', label: '看跌 Put' }]} />
          </> : <SecurityAutocompleteField label="证券代码 / 名称" value={symbol} onChange={(value) => { setSymbol(value.toUpperCase()); setLookupMessage(''); }} suggestions={securitySuggestions} onSelect={selectSuggestion} supportingText={lookupMessage || (securitySuggestions.length ? `找到 ${securitySuggestions.length} 条候选，点一下可自动补全` : '')} />}
          <FieldBlock label="转仓数量" value={quantity} onChange={setQuantity} type="number" step="0.0001" required supportingText="保存时按来源平台当前平均成本自动计算成本价。" />
          <section className="trade-fee-card"><div className="trade-fee-heading"><span>转仓费用（从来源平台扣除）</span></div><div className="trade-form-grid"><FieldBlock label="佣金" value={commission} onChange={setCommission} type="number" step="0.01" /><FieldBlock label="税费" value={tax} onChange={setTax} type="number" step="0.01" /></div></section>
        </> : <>
          <ChoiceGroup label="货币种类" value={cashCurrency} onChange={(value) => setCashCurrency(value as CurrencyType)} options={Object.values(DisplayCurrency).map((currency) => ({ value: currency.code, label: currency.label }))} />
          <FieldBlock label="转仓金额" value={price} onChange={(value) => { setPrice(value); setQuantity('1'); }} type="number" step="0.01" supportingText={`来源平台需有足够的${DisplayCurrency[cashCurrency].label}可用现金。`} required />
          <section className="trade-fee-card"><div className="trade-fee-heading"><span>转仓费用（从来源平台扣除）</span></div><div className="trade-form-grid"><FieldBlock label="佣金" value={commission} onChange={setCommission} type="number" step="0.01" /><FieldBlock label="税费" value={tax} onChange={setTax} type="number" step="0.01" /></div></section>
        </>}
      </> : isSecurity ? <>
        <ChoiceGroup label="市场" value={market} onChange={(value) => setMarket(value as MarketType)} options={SECURITY_MARKETS.map((value) => ({ value, label: Market[value].label }))} />
        {(market === 'US' || market === 'HK') && <ChoiceGroup label="资产类型" value={assetType} onChange={(value) => setAssetType(value as 'STOCK' | 'OPTION')} options={[{ value: 'STOCK', label: '股票' }, { value: 'OPTION', label: '期权' }]} />}
        {assetType === 'OPTION' && (market === 'US' || market === 'HK') ? <>
          <SecurityAutocompleteField label="正股代码" value={underlying} onChange={(value) => { setUnderlying(value.toUpperCase()); setLookupMessage(''); }} suggestions={securitySuggestions} onSelect={selectUnderlyingSuggestion} supportingText={lookupMessage || (securitySuggestions.length ? `找到 ${securitySuggestions.length} 条候选，点一下可自动补全` : '')} optionUnderlying />
          <div className="trade-form-grid">
            <FieldBlock label="到期日" value={expiry} onChange={setExpiry} type="date" required />
            <FieldBlock label="行权价" value={strike} onChange={setStrike} type="number" step="0.0001" required />
          </div>
          <ChoiceGroup label="期权类型" value={optionType} onChange={(value) => setOptionType(value as 'CALL' | 'PUT')} options={[{ value: 'CALL', label: '看涨 Call' }, { value: 'PUT', label: '看跌 Put' }]} />
        </> : <>
          <SecurityAutocompleteField label="证券代码 / 名称" value={symbol} onChange={(value) => { setSymbol(value.toUpperCase()); setLookupMessage(''); }} suggestions={securitySuggestions} onSelect={selectSuggestion} supportingText={lookupMessage || (securitySuggestions.length ? `找到 ${securitySuggestions.length} 条候选，点一下可自动补全` : '')} />
        </>}
        <div className="trade-form-grid">
          <FieldBlock label={tradeType === 'SPLIT' ? '折算比例' : '成交价格'} value={price} onChange={(value) => { setPrice(value); if (tradeType === 'SPLIT') setQuantity('1'); }} type="number" step="0.0001" required />
          {tradeType !== 'SPLIT' && <FieldBlock label={tradeType === 'EXPIRE' ? '过期数量' : '成交数量'} value={quantity} onChange={(value) => { setQuantity(value); if (tradeType === 'EXPIRE') setPrice('0'); }} type="number" step="0.0001" required />}
        </div>
        {tradeType !== 'SPLIT' && <section className="trade-fee-card"><div className="trade-fee-heading"><span>手续费 / 税费</span>{(tradeType === 'BUY' || tradeType === 'SELL') && <button type="button" className="trade-fee-estimate" disabled={estimatingFees} onClick={() => void estimateFees()}>{estimatingFees ? '估算中…' : '自动估算'}</button>}</div><div className="trade-form-grid"><FieldBlock label="佣金" value={commission} onChange={setCommission} type="number" step="0.01" /><FieldBlock label="税费" value={tax} onChange={setTax} type="number" step="0.01" /></div></section>}
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
