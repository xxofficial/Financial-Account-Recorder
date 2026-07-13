import React, { useState, useEffect } from 'react';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { TransactionRepository, AppSettingRepository } from '../db/repositories';
import { db } from '../db/localDb';
import { BrokerPlatform, TradeTypeLabels, PlatformType, MarketType, TradeType } from '../shared/models';
import { transactionSchema } from '../shared/schemas';
import { cacheService } from '../core/market/marketDataCacheService';
import { marketCacheManager } from '../core/market/marketCacheManager';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';

const txnRepo = new TransactionRepository();
const settingRepo = new AppSettingRepository();
const configurablePlatforms = Object.values(BrokerPlatform).filter((platform) => platform.isConfigurable);

export default function TransactionFormPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const isEdit = !!id;

  const [activeLedgerId, setActiveLedgerId] = useState<number>(1);
  const [loading, setLoading] = useState(true);

  // Form states
  const [tradeType, setTradeType] = useState<TradeType>('BUY');
  const [market, setMarket] = useState<MarketType>('US');
  const [assetType, setAssetType] = useState<'STOCK' | 'OPTION'>('STOCK');
  const [platform, setPlatform] = useState<PlatformType>('LONGBRIDGE');
  const enabledPlatformsValue = useLiveQuery(async () => (await db.appSettings.get('enabled_platforms'))?.value);
  const enabledPlatforms = Array.isArray(enabledPlatformsValue)
    ? configurablePlatforms.filter((candidate) => enabledPlatformsValue.includes(candidate.code))
    : configurablePlatforms;
  const selectablePlatforms = configurablePlatforms.filter((candidate) => enabledPlatforms.includes(candidate) || candidate.code === platform);
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [commission, setCommission] = useState('0');
  const [tax, setTax] = useState('0');
  const [tradeDate, setTradeDate] = useState(new Date().toISOString().split('T')[0]);
  const [tradeTime, setTradeTime] = useState('10:00:00');

  useEffect(() => {
    if (!isEdit && !enabledPlatforms.some((candidate) => candidate.code === platform)) {
      setPlatform(enabledPlatforms[0]?.code ?? 'LONGBRIDGE');
    }
  }, [enabledPlatforms, isEdit, platform]);
  const [note, setNote] = useState('');

  // Option specific states
  const [underlying, setUnderlying] = useState('');
  const [optionType, setOptionType] = useState<'CALL' | 'PUT'>('CALL');
  const [strike, setStrike] = useState('');
  const [expiry, setExpiry] = useState('');

  // FX specific states
  const [fxFromCurrency, setFxFromCurrency] = useState('USD');
  const [fxFromAmount, setFxFromAmount] = useState('');
  const [fxToCurrency, setFxToCurrency] = useState('CNY');
  const [fxToAmount, setFxToAmount] = useState('');
  const [fxRate, setFxRate] = useState('');

  // Load active ledger and transaction data (if editing)
  useEffect(() => {
    async function loadData() {
      try {
        const ledgerIdSetting = await settingRepo.get('default_ledger');
        const currentLedgerId = typeof ledgerIdSetting === 'number' ? ledgerIdSetting : 1;
        setActiveLedgerId(currentLedgerId);

        if (isEdit) {
          const txn = await txnRepo.get(parseInt(id));
          if (txn) {
            setTradeType(txn.tradeType as TradeType);
            setMarket(txn.market as MarketType);
            setAssetType((txn.assetType || 'STOCK') as 'STOCK' | 'OPTION');
            setPlatform(txn.platform as PlatformType);
            setSymbol(txn.symbol);
            setName(txn.name);
            setPrice(txn.price.toString());
            setQuantity(txn.quantity.toString());
            setCommission(txn.commission.toString());
            setTax(txn.tax.toString());
            setTradeDate(txn.tradeDate);
            setTradeTime(txn.tradeTime);
            setNote(txn.note || '');

            if (txn.assetType === 'OPTION') {
              setUnderlying(txn.underlyingSymbol || '');
              setOptionType((txn.optionType || 'CALL') as 'CALL' | 'PUT');
              setStrike(txn.strikePrice?.toString() || '');
              setExpiry(txn.expiryDate || '');
            }

            if (txn.tradeType === 'FX_CONVERSION') {
              setFxFromCurrency(txn.fxFromCurrency || 'USD');
              setFxFromAmount(txn.fxFromAmount?.toString() || '');
              setFxToCurrency(txn.fxToCurrency || 'CNY');
              setFxToAmount(txn.fxToAmount?.toString() || '');
              setFxRate(txn.fxRate?.toString() || '');
            }
          } else {
            alert('未找到该笔交易记录！');
            navigate('/transactions');
          }
        } else {
          const requestedType = searchParams.get('type') as TradeType | null;
          if (requestedType && Object.prototype.hasOwnProperty.call(TradeTypeLabels, requestedType)) {
            setTradeType(requestedType);
          }
        }
      } catch (err) {
        console.error('加载交易表单数据失败:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [id, isEdit, navigate, searchParams]);

  // Auto-fill security name when symbol changes
  useEffect(() => {
    if (assetType === 'STOCK' && symbol.trim().length >= 2 && market !== 'CASH' && tradeType !== 'FX_CONVERSION') {
      const cleanSymbol = symbol.trim().toUpperCase();
      const delayDebounceFn = setTimeout(async () => {
        try {
          const resolvedName = await cacheService.resolveSecurityName(cleanSymbol, market);
          if (resolvedName) {
            setName(resolvedName);
          }
        } catch (e) {
          console.warn('Auto name resolution failed:', e);
        }
      }, 500); // 500ms debounce to avoid spamming APIs while typing

      return () => clearTimeout(delayDebounceFn);
    }
  }, [symbol, market, assetType, tradeType]);

  // Adjust defaults when tradeType changes
  const handleTradeTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as TradeType;
    setTradeType(val);

    if (val === 'DEPOSIT' || val === 'WITHDRAW' || val === 'INTEREST') {
      setMarket('CASH');
      setSymbol('CASH');
      setName('现金');
    } else if (val === 'FX_CONVERSION') {
      setMarket('CASH');
      setSymbol('FX');
      setName('外汇兑换');
    } else if (market === 'CASH') {
      setMarket('US');
      setSymbol('');
      setName('');
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isEdit || !id) return;
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      alert('无效的交易记录 ID！');
      return;
    }
    const confirmDelete = window.confirm('确认要删除此笔交易记录吗？此操作不可逆！');
    if (confirmDelete) {
      try {
        console.log('Executing delete for transaction ID:', numericId);
        await txnRepo.delete(numericId);
        alert('交易已成功删除！');
        navigate('/transactions');
      } catch (err) {
        console.error('删除交易失败:', err);
        alert('删除失败，请重试');
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const computedSymbol = (tradeType === 'DEPOSIT' || tradeType === 'WITHDRAW' || tradeType === 'INTEREST') ? 'CASH' : 
                          (tradeType === 'FX_CONVERSION') ? 'FX' :
                          (assetType === 'OPTION') ? `${underlying.trim().toUpperCase()} ${expiry.replace(/-/g, '').substring(2)}${optionType.charAt(0)}${strike}` : 
                          symbol.trim();

    const computedName = (tradeType === 'DEPOSIT' || tradeType === 'WITHDRAW' || tradeType === 'INTEREST') ? '现金' : 
                        (tradeType === 'FX_CONVERSION') ? '外汇兑换' :
                        (assetType === 'OPTION') ? `${underlying.trim().toUpperCase()} ${expiry} ${optionType === 'CALL' ? 'CALL' : 'PUT'} $${strike}` : 
                        name.trim();

    // Map input strings into schema-compatible types
    const parsedData = {
      ledgerId: activeLedgerId,
      tradeType,
      platform,
      market,
      symbol: computedSymbol,
      name: computedName,
      tradeDate,
      tradeTime: tradeTime.includes(':') ? (tradeTime.split(':').length === 2 ? tradeTime + ':00' : tradeTime) : '00:00:00',
      price: parseFloat(price) || 0,
      quantity: parseFloat(quantity) || 0,
      commission: parseFloat(commission) || 0,
      tax: parseFloat(tax) || 0,
      note: note.trim(),
      investorName: null,
      sourceChannel: null,
      externalReference: null,

      // Options
      assetType: (market === 'US' || market === 'HK') ? assetType : 'STOCK',
      underlyingSymbol: assetType === 'OPTION' ? underlying.trim().toUpperCase() : null,
      expiryDate: assetType === 'OPTION' ? expiry : null,
      strikePrice: assetType === 'OPTION' ? (parseFloat(strike) || null) : null,
      optionType: assetType === 'OPTION' ? optionType : null,

      // FX Conversion
      fxFromCurrency: tradeType === 'FX_CONVERSION' ? fxFromCurrency : null,
      fxFromAmount: tradeType === 'FX_CONVERSION' ? (parseFloat(fxFromAmount) || null) : null,
      fxToCurrency: tradeType === 'FX_CONVERSION' ? fxToCurrency : null,
      fxToAmount: tradeType === 'FX_CONVERSION' ? (parseFloat(fxToAmount) || null) : null,
      fxRate: tradeType === 'FX_CONVERSION' ? (parseFloat(fxRate) || null) : null,
    };

    // Zod validation
    const result = transactionSchema.safeParse(parsedData);
    if (!result.success) {
      const messages = result.error.issues.map(issue => {
        const field = issue.path.join('.');
        return `${field === 'assetType' || field === 'tradeType' ? '' : field + ': '}${issue.message}`;
      });
      alert(`表单验证错误:\n${messages.join('\n')}`);
      return;
    }

    try {
      const payload = {
        ledgerId: result.data.ledgerId,
        tradeType: result.data.tradeType,
        platform: result.data.platform,
        market: result.data.market,
        symbol: result.data.symbol,
        name: result.data.name,
        tradeDate: result.data.tradeDate,
        tradeTime: result.data.tradeTime,
        price: result.data.price,
        quantity: result.data.quantity,
        commission: result.data.commission,
        tax: result.data.tax,
        note: result.data.note,
        investorName: result.data.investorName ?? null,
        sourceChannel: null,
        externalReference: null,
        assetType: result.data.assetType,
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
      if (isEdit) {
        await txnRepo.update(parseInt(id), payload);
      } else {
        await txnRepo.create(payload);
      }
      const autoSync = await settingRepo.get('auto_sync_after_transaction');
      if (autoSync) {
        await marketCacheManager.detectAndQueueMissingRanges();
        await MarketTaskExecutor.startOrWakeMarketExecutor();
      }
      navigate('/transactions');
    } catch (err) {
      console.error('保存交易失败:', err);
      alert('保存失败，请检查输入或重试！');
    }
  };

  if (loading) {
    return (
      <div className="flex-center" style={{ height: '80vh', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ color: 'var(--text-secondary)' }}>加载中...</div>
      </div>
    );
  }

  return (
    <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Header */}
      <div className="flex-between">
        <button type="button" onClick={() => navigate('/transactions')} style={{ padding: '0.5rem', background: 'none', border: 'none' }}>
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>
          {isEdit ? '编辑交易' : '记一笔交易'}
        </h1>
        {isEdit ? (
          <button type="button" className="danger" onClick={handleDelete} style={{ padding: '0.5rem' }} title="删除交易">
            <Trash2 size={16} />
          </button>
        ) : (
          <div style={{ width: '40px' }} />
        )}
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        {/* Basic configuration */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>交易类型</label>
            <select value={tradeType} onChange={handleTradeTypeChange}>
              {Object.entries(TradeTypeLabels).map(([val, label]) => (
                <option key={val} value={val}>{label} ({val})</option>
              ))}
            </select>
          </div>

          <div className="grid-cols-2">
            <div>
              <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>交易市场</label>
              <select 
                value={market} 
                onChange={(e) => setMarket(e.target.value as MarketType)} 
                disabled={tradeType === 'DEPOSIT' || tradeType === 'WITHDRAW' || tradeType === 'INTEREST' || tradeType === 'FX_CONVERSION'}
              >
                {tradeType !== 'DEPOSIT' && tradeType !== 'WITHDRAW' && tradeType !== 'INTEREST' && tradeType !== 'FX_CONVERSION' ? (
                  <>
                    <option value="US">美股 (US)</option>
                    <option value="HK">港股 (HK)</option>
                    <option value="A_SHARE">A股 (A股)</option>
                  </>
                ) : (
                  <option value="CASH">现金 (CASH)</option>
                )}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>券商平台</label>
              <select value={platform} onChange={(e) => setPlatform(e.target.value as PlatformType)}>
                {selectablePlatforms.map(p => (
                  <option key={p.code} value={p.code}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Asset Type (Only valid for US / HK securities trades) */}
          {(market === 'US' || market === 'HK') && 
            tradeType !== 'DEPOSIT' && 
            tradeType !== 'WITHDRAW' && 
            tradeType !== 'INTEREST' && 
            tradeType !== 'FX_CONVERSION' && (
            <div>
              <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>资产类型</label>
              <select value={assetType} onChange={(e) => setAssetType(e.target.value as any)}>
                <option value="STOCK">股票 (STOCK)</option>
                <option value="OPTION">期权 (OPTION)</option>
              </select>
            </div>
          )}
        </div>

        {/* Dynamic Detail input sections */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem' }}>
            {tradeType === 'DEPOSIT' || tradeType === 'WITHDRAW' || tradeType === 'INTEREST' ? '出入金 / 利息明细' : '证券 / 外汇明细'}
          </h3>

          {/* FX Conversion sub-form */}
          {tradeType === 'FX_CONVERSION' && (
            <>
              <div className="grid-cols-2">
                <div>
                  <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>源货币 (From)</label>
                  <select value={fxFromCurrency} onChange={(e) => setFxFromCurrency(e.target.value)}>
                    <option value="USD">美元 (USD)</option>
                    <option value="HKD">港币 (HKD)</option>
                    <option value="CNY">人民币 (CNY)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>源金额</label>
                  <input type="number" step="0.01" placeholder="兑换支出的金额" value={fxFromAmount} onChange={(e) => setFxFromAmount(e.target.value)} required />
                </div>
              </div>
              <div className="grid-cols-2">
                <div>
                  <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>目标货币 (To)</label>
                  <select value={fxToCurrency} onChange={(e) => setFxToCurrency(e.target.value)}>
                    <option value="CNY">人民币 (CNY)</option>
                    <option value="USD">美元 (USD)</option>
                    <option value="HKD">港币 (HKD)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>目标金额</label>
                  <input type="number" step="0.01" placeholder="兑换收到的金额" value={fxToAmount} onChange={(e) => setFxToAmount(e.target.value)} required />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>汇率 (Rate)</label>
                <input type="number" step="0.00001" placeholder="兑换汇率" value={fxRate} onChange={(e) => setFxRate(e.target.value)} required />
              </div>
            </>
          )}

          {/* Security trades (STOCK/OPTION) */}
          {tradeType !== 'DEPOSIT' && 
           tradeType !== 'WITHDRAW' && 
           tradeType !== 'INTEREST' && 
           tradeType !== 'FX_CONVERSION' && (
            <>
              {assetType === 'OPTION' && (market === 'US' || market === 'HK') ? (
                <>
                  <div className="grid-cols-2">
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>标的股票代码 (Underlying)</label>
                      <input type="text" placeholder="例如 AAPL" value={underlying} onChange={(e) => setUnderlying(e.target.value.toUpperCase())} required />
                    </div>
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>期权类型</label>
                      <select value={optionType} onChange={(e) => setOptionType(e.target.value as any)}>
                        <option value="CALL">看涨 (CALL)</option>
                        <option value="PUT">看跌 (PUT)</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid-cols-2">
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>行权价</label>
                      <input type="number" step="0.5" placeholder="行权价" value={strike} onChange={(e) => setStrike(e.target.value)} required />
                    </div>
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>到期日</label>
                      <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} required />
                    </div>
                  </div>
                  {/* For option transactions, show a computed Option symbol field */}
                  <div>
                    <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>自动生成期权合约代码</label>
                    <input 
                      type="text" 
                      value={`${underlying} ${expiry.replace(/-/g, '').substring(2)}${optionType.charAt(0)}${strike}`} 
                      disabled 
                      style={{ opacity: 0.7, cursor: 'not-allowed' }}
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>标的代码</label>
                  <input 
                    type="text" 
                    placeholder={market === 'HK' ? '例如 00700' : market === 'A_SHARE' ? '例如 600519' : '例如 AAPL'} 
                    value={symbol} 
                    onChange={(e) => setSymbol(e.target.value.toUpperCase())} 
                    required 
                  />
                  {name && name !== symbol && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--accent)', marginTop: '0.35rem', fontWeight: 500 }}>
                      已解析证券名称: {name}
                    </div>
                  )}
                </div>
              )}

              {/* Price, Quantity & Fees */}
              {tradeType !== 'SPLIT' && tradeType !== 'EXPIRE' ? (
                <>
                  <div className="grid-cols-2">
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>单股价格</label>
                      <input type="number" step="0.0001" placeholder="成交单价" value={price} onChange={(e) => setPrice(e.target.value)} required />
                    </div>
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>成交股数 / 合约数</label>
                      <input type="number" step="0.0001" placeholder="数量" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
                    </div>
                  </div>
                  
                  {/* Fees */}
                  <div className="grid-cols-2">
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>佣金 (Fees)</label>
                      <input type="number" step="0.01" value={commission} onChange={(e) => setCommission(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>印花税 / 税费</label>
                      <input type="number" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} />
                    </div>
                  </div>
                </>
              ) : tradeType === 'SPLIT' ? (
                <div>
                  <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>拆股比例 (如 1 拆 2 填 2，2 合 1 填 0.5)</label>
                  <input type="number" step="0.000001" placeholder="比例" value={price} onChange={(e) => { setPrice(e.target.value); setQuantity('1'); }} required />
                </div>
              ) : (
                <div>
                  <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>过期数量 / 合约数</label>
                  <input type="number" step="0.0001" placeholder="到期注销合约数量" value={quantity} onChange={(e) => { setQuantity(e.target.value); setPrice('0'); }} required />
                </div>
              )}
            </>
          )}

          {/* Simple cash/money fields */}
          {(tradeType === 'DEPOSIT' || tradeType === 'WITHDRAW' || tradeType === 'INTEREST') && (
            <div>
              <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>金额</label>
              <input 
                type="number" 
                step="0.01" 
                placeholder="出入金或利息金额" 
                value={price} 
                onChange={(e) => { setPrice(e.target.value); setQuantity('1'); }} 
                required 
              />
            </div>
          )}
        </div>

        {/* Date and note */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="grid-cols-2">
            <div>
              <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>交易日期</label>
              <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} required />
            </div>
            <div>
              <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>交易时间</label>
              <input type="text" placeholder="HH:mm:ss" value={tradeTime} onChange={(e) => setTradeTime(e.target.value)} required />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>备注</label>
            <textarea placeholder="记下这笔交易的心得或额外细节..." rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        {/* Actions */}
        <button type="submit" className="primary" style={{ padding: '0.85rem' }}>
          <Save size={18} />
          {isEdit ? '保存交易修改' : '保存交易记录'}
        </button>
      </form>
    </div>
  );
}
