/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CalendarDays,
  Check,
  Filter,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/localDb';
import { TransactionRepository } from '../db/repositories';
import { Market, BrokerPlatform, TradeTypeLabels, type MarketType, type PlatformType, type TradeType } from '../shared/models';
import { PlatformMark, useAppShell } from '../app/AppShell';
import type { Transaction, Ledger } from '../db/schema';
import type { ReactNode } from 'react';

const txnRepo = new TransactionRepository();

type CashFlowFilter = 'ALL' | 'INFLOW' | 'OUTFLOW';
type CurrencyFilter = 'ALL' | 'USD' | 'HKD' | 'CNY';
type SceneFilter = 'ALL' | 'STOCK_TRADE' | 'OPTION_TRADE' | 'MARGIN' | 'IPO' | 'CASH_IO' | 'CORPORATE_ACTION' | 'FX_CONVERSION' | 'CAPITAL_TRANSFER' | 'OTHER';

const currencyOptions: Array<[CurrencyFilter, string]> = [['ALL', '全部币种'], ['USD', '美元'], ['HKD', '港币'], ['CNY', '人民币']];
const sceneOptions: Array<[SceneFilter, string]> = [
  ['ALL', '全部场景'], ['STOCK_TRADE', '股票交易'], ['OPTION_TRADE', '期权交易'], ['MARGIN', '融资融券'],
  ['IPO', '新股申购'], ['CASH_IO', '出入金'], ['CORPORATE_ACTION', '公司行动'], ['FX_CONVERSION', '货币兑换'],
  ['CAPITAL_TRANSFER', '资金调拨'], ['OTHER', '其他'],
];

function tradeType(tx: Transaction): TradeType {
  return tx.tradeType;
}

export function cashFlow(tx: Transaction): number {
  const type = tradeType(tx);
  const multiplier = tx.assetType === 'OPTION' ? 100 : 1;
  const gross = tx.price * tx.quantity * multiplier;
  const fees = tx.commission + tx.tax;
  switch (type) {
    case 'BUY': return -(gross + fees);
    case 'SELL': return gross - fees;
    case 'DEPOSIT':
    case 'TRANSFER_IN': return gross;
    case 'WITHDRAW':
    case 'TRANSFER_OUT':
    case 'INTEREST':
    case 'TAX': return -gross;
    case 'DIVIDEND': return gross - tx.tax;
    case 'OTHER': return gross;
    default: return 0;
  }
}

function isIpo(tx: Transaction): boolean {
  const text = [tx.externalReference, tx.name, tx.note].filter(Boolean).join(' ');
  return /IPO|新股|中签|中簽/i.test(text);
}

export function sceneFor(tx: Transaction): SceneFilter {
  const type = tradeType(tx);
  if (isIpo(tx)) return 'IPO';
  if (type === 'FX_CONVERSION') return 'FX_CONVERSION';
  if (type === 'INTEREST') return 'MARGIN';
  if (type === 'DEPOSIT' || type === 'WITHDRAW') return 'CASH_IO';
  if (type === 'TRANSFER_IN' || type === 'TRANSFER_OUT') return 'CAPITAL_TRANSFER';
  if (tx.assetType === 'OPTION' && ['BUY', 'SELL', 'EXPIRE'].includes(type)) return 'OPTION_TRADE';
  if (['DIVIDEND', 'TAX', 'SPLIT', 'EXPIRE'].includes(type)) return 'CORPORATE_ACTION';
  if (type === 'BUY' || type === 'SELL') return 'STOCK_TRADE';
  return 'OTHER';
}

export function currencyFor(tx: Transaction): CurrencyFilter {
  if (tx.tradeType === 'FX_CONVERSION') {
    if ([tx.fxFromCurrency, tx.fxToCurrency].some((value) => value?.toUpperCase() === 'USD')) return 'USD';
    if ([tx.fxFromCurrency, tx.fxToCurrency].some((value) => value?.toUpperCase() === 'HKD')) return 'HKD';
  }
  if (tx.market === 'US') return 'USD';
  if (tx.market === 'HK') return 'HKD';
  return 'CNY';
}

export function formatDateTitle(date: string): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${year}年${Number(month)}月${Number(day)}日` : date;
}

function formatAmount(value: number, market: string): string {
  const info = Market[(market in Market ? market : 'CASH') as MarketType];
  if (Math.abs(value) < 0.005) return `${info.currencySymbol}0.00`;
  const sign = value > 0 ? '+' : '-';
  return `${sign}${info.currencySymbol}${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function titleFor(tx: Transaction): string {
  if (tx.tradeType === 'FX_CONVERSION') return `${tx.fxFromCurrency ?? ''} → ${tx.fxToCurrency ?? ''}`.trim() || '货币兑换';
  if (tx.tradeType === 'DEPOSIT' || tx.tradeType === 'WITHDRAW') return `${Market[(tx.market in Market ? tx.market : 'CASH') as MarketType].currencySymbol} 资金账户`;
  if (tx.tradeType === 'INTEREST') return '融资利息';
  if (tx.tradeType === 'TAX') return tx.name || '公司行动费用';
  if (tx.tradeType === 'OTHER') return tx.name || (tx.price < 0 ? '其他支出' : '其他收入');
  return tx.name || tx.symbol || '未命名证券';
}

function detailsFor(tx: Transaction): string[] {
  const market = Market[(tx.market in Market ? tx.market : 'CASH') as MarketType];
  const fee = tx.commission + tx.tax;
  if (tx.tradeType === 'BUY' || tx.tradeType === 'SELL') {
    return [`成交价 ${market.currencySymbol}${tx.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}`, `${tx.quantity} ${tx.assetType === 'OPTION' ? '张' : '股'}`, ...(fee > 0 ? [`费用 ${market.currencySymbol}${fee.toFixed(2)}`] : [])];
  }
  if (tx.tradeType === 'DIVIDEND') return [`分红 ${market.currencySymbol}${(tx.price * tx.quantity).toFixed(2)}`, ...(tx.tax > 0 ? [`扣税 ${market.currencySymbol}${tx.tax.toFixed(2)}`] : [])];
  if (tx.tradeType === 'FX_CONVERSION') return [tx.fxFromAmount != null && tx.fxFromCurrency ? `卖出 ${tx.fxFromAmount} ${tx.fxFromCurrency}` : '', tx.fxToAmount != null && tx.fxToCurrency ? `买入 ${tx.fxToAmount} ${tx.fxToCurrency}` : ''].filter(Boolean);
  return [];
}

export function groupTransactionsByDate(transactions: Transaction[]): Array<[string, Transaction[]]> {
  const groups = new Map<string, Transaction[]>();
  transactions.forEach((tx) => groups.set(tx.tradeDate, [...(groups.get(tx.tradeDate) ?? []), tx]));
  return [...groups.entries()].sort(([left], [right]) => right.localeCompare(left));
}

const WHEEL_ROW_HEIGHT = 42;
const MIN_WHEEL_DATE = '2000-01-01';

function parseIsoDate(value: string, fallback: string): Date {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(`${fallback}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? new Date(`${fallback}T00:00:00Z`) : parsed;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function clampDate(value: Date, min: string, max: string): Date {
  const minDate = parseIsoDate(min, min);
  const maxDate = parseIsoDate(max, max);
  return new Date(Math.min(Math.max(value.getTime(), minDate.getTime()), maxDate.getTime()));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function WheelColumn({ label, values, selected, onChange }: { label: (value: number) => string; values: number[]; selected: number; onChange: (value: number) => void }) {
  const columnRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const index = Math.max(0, values.indexOf(selected));
    if (columnRef.current) columnRef.current.scrollTop = index * WHEEL_ROW_HEIGHT;
  }, [selected, values]);
  return <div className="transactions-wheel-column" ref={columnRef} role="listbox" aria-label={label(selected)} onScroll={(event) => {
    const target = event.currentTarget;
    const index = Math.max(0, Math.min(values.length - 1, Math.round(target.scrollTop / WHEEL_ROW_HEIGHT)));
    if (values[index] !== selected) onChange(values[index]);
  }}>
    <div className="transactions-wheel-spacer" />
    {values.map((value) => <button type="button" role="option" aria-selected={value === selected} className={value === selected ? 'selected' : ''} key={value} onClick={() => onChange(value)}>{label(value)}</button>)}
    <div className="transactions-wheel-spacer" />
  </div>;
}

function WheelDateRangePicker({ startDate, endDate, activeSide, onSideChange, onChange }: { startDate: string; endDate: string; activeSide: 'start' | 'end'; onSideChange: (side: 'start' | 'end') => void; onChange: (side: 'start' | 'end', value: string) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const activeDate = clampDate(parseIsoDate(activeSide === 'start' ? startDate : endDate, today), MIN_WHEEL_DATE, today);
  const years = Array.from({ length: new Date(`${today}T00:00:00Z`).getUTCFullYear() - 1999 }, (_, index) => 2000 + index);
  const months = Array.from({ length: 12 }, (_, index) => index + 1).filter((month) => activeDate.getUTCFullYear() < new Date(`${today}T00:00:00Z`).getUTCFullYear() || month <= new Date(`${today}T00:00:00Z`).getUTCMonth() + 1);
  const maxDay = activeDate.getUTCFullYear() === new Date(`${today}T00:00:00Z`).getUTCFullYear() && activeDate.getUTCMonth() + 1 === new Date(`${today}T00:00:00Z`).getUTCMonth() + 1 ? new Date(`${today}T00:00:00Z`).getUTCDate() : daysInMonth(activeDate.getUTCFullYear(), activeDate.getUTCMonth() + 1);
  const days = Array.from({ length: maxDay }, (_, index) => index + 1);
  const update = (part: 'year' | 'month' | 'day', value: number) => {
    const year = part === 'year' ? value : activeDate.getUTCFullYear();
    const month = part === 'month' ? value : activeDate.getUTCMonth() + 1;
    const day = Math.min(part === 'day' ? value : activeDate.getUTCDate(), daysInMonth(year, month));
    onChange(activeSide, isoDate(clampDate(new Date(Date.UTC(year, month - 1, day)), MIN_WHEEL_DATE, today)));
  };
  return <div className="transactions-wheel-picker">
    <div className="transactions-wheel-pills"><button type="button" className={activeSide === 'start' ? 'selected' : ''} onClick={() => onSideChange('start')}>{startDate || '开始日期'}</button><span>—</span><button type="button" className={activeSide === 'end' ? 'selected' : ''} onClick={() => onSideChange('end')}>{endDate || '结束日期'}</button></div>
    <div className="transactions-wheel-columns"><div className="transactions-wheel-selection-line" /><WheelColumn values={years} selected={activeDate.getUTCFullYear()} label={(value) => `${value}年`} onChange={(value) => update('year', value)} /><WheelColumn values={months} selected={activeDate.getUTCMonth() + 1} label={(value) => `${value}月`} onChange={(value) => update('month', value)} /><WheelColumn values={days} selected={activeDate.getUTCDate()} label={(value) => `${value}`} onChange={(value) => update('day', value)} /></div>
  </div>;
}

export function LongPressButton({ className, children, onClick, onLongPress }: { className?: string; children: ReactNode; onClick: () => void; onLongPress: () => void }) {
  const timer = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  const suppressClick = useRef(false);
  const clear = () => { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; };
  return <button type="button" className={className} onPointerDown={(event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    longPressed.current = false;
    clear();
    timer.current = window.setTimeout(() => { longPressed.current = true; suppressClick.current = true; onLongPress(); }, 500);
  }} onPointerMove={(event) => { if (Math.abs(event.movementX) > 8 || Math.abs(event.movementY) > 8) clear(); }} onPointerUp={() => { clear(); }} onPointerCancel={() => { clear(); }} onContextMenu={(event) => event.preventDefault()} onClick={(event) => {
    if (suppressClick.current || longPressed.current) { event.preventDefault(); suppressClick.current = false; longPressed.current = false; return; }
    onClick();
  }}>{children}</button>;
}

export default function TransactionsPage() {
  const navigate = useNavigate();
  const { activePlatform } = useAppShell();
  const activeLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value ?? 1) as number | undefined;
  const ledgers = useLiveQuery(() => db.ledgers.toArray(), []) ?? [];
  const liveTransactions = useLiveQuery(async () => {
    const ledgerId = typeof activeLedgerId === 'number' ? activeLedgerId : 1;
    const rows = ledgerId === 0 ? await db.transactions.toArray() : await db.transactions.where('ledgerId').equals(ledgerId).toArray();
    return activePlatform ? rows.filter((row) => row.platform === activePlatform) : rows;
  }, [activeLedgerId, activePlatform]);
  const rawTransactions = useMemo(() => liveTransactions ?? [], [liveTransactions]);

  const [searchTerm, setSearchTerm] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [cashFilter, setCashFilter] = useState<CashFlowFilter>('ALL');
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const [sceneFilter, setSceneFilter] = useState<SceneFilter>('ALL');
  const [showDateSheet, setShowDateSheet] = useState(false);
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [showBatchMode, setShowBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showMoveLedger, setShowMoveLedger] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingStart, setPendingStart] = useState('');
  const [pendingEnd, setPendingEnd] = useState('');
  const [pendingDateSide, setPendingDateSide] = useState<'start' | 'end'>('start');
  const [pendingCash, setPendingCash] = useState<CashFlowFilter>('ALL');
  const [pendingCurrency, setPendingCurrency] = useState<CurrencyFilter>('ALL');
  const [pendingScene, setPendingScene] = useState<SceneFilter>('ALL');

  const filtered = useMemo(() => rawTransactions.filter((tx) => {
    const keyword = searchTerm.trim().toLowerCase();
    if (keyword && ![tx.symbol, tx.name, tx.note].some((value) => value?.toLowerCase().includes(keyword))) return false;
    if (startDate && tx.tradeDate < startDate) return false;
    if (endDate && tx.tradeDate > endDate) return false;
    const flow = cashFlow(tx);
    if (cashFilter === 'INFLOW' && flow <= 0) return false;
    if (cashFilter === 'OUTFLOW' && flow >= 0) return false;
    if (currencyFilter !== 'ALL' && currencyFor(tx) !== currencyFilter) return false;
    if (sceneFilter !== 'ALL' && sceneFor(tx) !== sceneFilter) return false;
    return true;
  }).sort((a, b) => `${b.tradeDate} ${b.tradeTime}`.localeCompare(`${a.tradeDate} ${a.tradeTime}`)), [rawTransactions, searchTerm, startDate, endDate, cashFilter, currencyFilter, sceneFilter]);

  const sections = useMemo(() => groupTransactionsByDate(filtered), [filtered]);

  const hasFilters = cashFilter !== 'ALL' || currencyFilter !== 'ALL' || sceneFilter !== 'ALL' || Boolean(startDate || endDate);
  const toggleSelection = (id: number) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const exitBatchMode = () => { setShowBatchMode(false); setSelectedIds(new Set()); };
  const selectAll = () => setSelectedIds(selectedIds.size === filtered.length ? new Set() : new Set(filtered.map((tx) => tx.id).filter((id): id is number => typeof id === 'number')));

  const applyDateRange = () => {
    const normalized = pendingStart && pendingEnd && pendingStart > pendingEnd ? [pendingEnd, pendingStart] : [pendingStart, pendingEnd];
    setStartDate(normalized[0]); setEndDate(normalized[1]); setShowDateSheet(false);
  };
  const applyCategoryFilters = () => { setCashFilter(pendingCash); setCurrencyFilter(pendingCurrency); setSceneFilter(pendingScene); setShowFilterSheet(false); };
  const deleteSelected = async () => { await Promise.all([...selectedIds].map((id) => txnRepo.delete(id))); setShowDeleteConfirm(false); exitBatchMode(); };
  const moveSelected = useCallback(async (targetLedgerId: number) => {
    await Promise.all([...selectedIds].map((id) => txnRepo.update(id, { ledgerId: targetLedgerId })));
    setShowMoveLedger(false); exitBatchMode();
  }, [selectedIds]);

  return <div className="page tab-page transactions-page">
    <div className="transactions-filter-bar">
      {showBatchMode ? <div className="transactions-batch-header"><button type="button" className="transactions-filter-button" onClick={selectAll}>{selectedIds.size === filtered.length && filtered.length > 0 ? '取消全选' : '全选'}</button><span>已选 {selectedIds.size} 笔</span><button type="button" className="transactions-filter-button" onClick={exitBatchMode}>取消</button></div> : <>
        <label className="transactions-search"><Search size={17} aria-hidden="true" /><input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="搜索证券名称或代码" /></label>
        <button type="button" className={`transactions-filter-button ${startDate || endDate ? 'active' : ''}`} onClick={() => { setPendingStart(startDate); setPendingEnd(endDate); setPendingDateSide('start'); setShowDateSheet(true); }}><CalendarDays size={17} />日期</button>
        <button type="button" className={`transactions-filter-button ${hasFilters && !(startDate || endDate) ? 'active' : ''}`} onClick={() => { setPendingCash(cashFilter); setPendingCurrency(currencyFilter); setPendingScene(sceneFilter); setShowFilterSheet(true); }}><Filter size={17} />筛选</button>
      </>}
    </div>

    <div className="transactions-list">
      {liveTransactions === undefined ? <div className="transactions-empty">加载中...</div> : sections.length === 0 ? <div className="transactions-empty">当前条件下没有流水记录。</div> : sections.map(([date, items]) => <section className="transaction-date-section" key={date}>
        <h2>{formatDateTitle(date)}</h2>
        <div className="transaction-group-card">{items.map((tx) => {
          const id = tx.id ?? 0;
          const amount = cashFlow(tx);
          const positive = amount > 0;
          const negative = amount < 0;
          const type = tradeType(tx);
          const platform = (tx.platform in BrokerPlatform ? tx.platform : 'UNSPECIFIED') as PlatformType;
          return <LongPressButton className={`transaction-row-card ${selectedIds.has(id) ? 'selected' : ''}`} key={id} onClick={() => showBatchMode ? toggleSelection(id) : navigate(`/transactions/${id}`)} onLongPress={() => { if (!showBatchMode) setShowBatchMode(true); toggleSelection(id); }}>
            <span className="transaction-row-top"><PlatformMark platform={platform} className="transaction-platform-mark" /><span className={`transaction-type-badge ${positive ? 'positive' : negative ? 'negative' : 'neutral'}`}>{tx.assetType === 'OPTION' && (type === 'BUY' || type === 'SELL') ? `期权${TradeTypeLabels[type]}` : isIpo(tx) ? '新股' : TradeTypeLabels[type]}</span><span className="transaction-row-market">{Market[(tx.market in Market ? tx.market : 'CASH') as MarketType].label}</span><strong className={positive ? 'positive' : negative ? 'negative' : ''}>{type === 'FX_CONVERSION' ? '换汇' : type === 'SPLIT' ? '--' : formatAmount(amount, tx.market)}</strong></span>
            <span className="transaction-row-meta"><span className="transaction-row-title">{titleFor(tx)}</span><span className="transaction-row-time">{tx.tradeTime?.slice(0, 5)}</span></span>
            {detailsFor(tx).length > 0 && <span className="transaction-row-details">{detailsFor(tx).join(' · ')}</span>}
            {showBatchMode && <span className={`transaction-checkbox ${selectedIds.has(id) ? 'checked' : ''}`}>{selectedIds.has(id) && <Check size={13} />}</span>}
          </LongPressButton>;
        })}</div>
      </section>)}
    </div>

    {showBatchMode && selectedIds.size > 0 && <div className="transactions-batch-actions"><button type="button" className="danger" onClick={() => setShowDeleteConfirm(true)}><Trash2 size={16} />删除所选 ({selectedIds.size})</button><button type="button" onClick={() => setShowMoveLedger(true)}>变更账本</button></div>}

    {showDateSheet && <div className="transactions-modal-backdrop" onClick={() => setShowDateSheet(false)}><div className="transactions-sheet" onClick={(event) => event.stopPropagation()}><div className="transactions-sheet-header"><h2>时间筛选</h2><button type="button" onClick={() => setShowDateSheet(false)}><X size={19} /></button></div><div className="transactions-sheet-scroll"><WheelDateRangePicker startDate={pendingStart} endDate={pendingEnd} activeSide={pendingDateSide} onSideChange={setPendingDateSide} onChange={(side, value) => { if (side === 'start') setPendingStart(value); else setPendingEnd(value); }} /></div><div className="transactions-sheet-actions"><button type="button" onClick={() => { setPendingStart(''); setPendingEnd(''); setStartDate(''); setEndDate(''); setShowDateSheet(false); }}>清空时间</button><button type="button" className="primary" onClick={applyDateRange}>确定</button></div></div></div>}
    {showFilterSheet && <div className="transactions-modal-backdrop" onClick={() => setShowFilterSheet(false)}><div className="transactions-sheet" onClick={(event) => event.stopPropagation()}><div className="transactions-sheet-header"><h2>类型筛选</h2><button type="button" onClick={() => setShowFilterSheet(false)}><X size={19} /></button></div><div className="transactions-sheet-scroll"><FilterGroup label="资金流向" options={[['ALL', '全部'], ['INFLOW', '流入'], ['OUTFLOW', '流出']]} value={pendingCash} onChange={(value) => setPendingCash(value as CashFlowFilter)} /><FilterGroup label="币种" options={currencyOptions} value={pendingCurrency} onChange={(value) => setPendingCurrency(value as CurrencyFilter)} /><FilterGroup label="业务场景" options={sceneOptions} value={pendingScene} onChange={(value) => setPendingScene(value as SceneFilter)} /></div><div className="transactions-sheet-actions"><button type="button" onClick={() => { setPendingCash('ALL'); setPendingCurrency('ALL'); setPendingScene('ALL'); setCashFilter('ALL'); setCurrencyFilter('ALL'); setSceneFilter('ALL'); setShowFilterSheet(false); }}>清空筛选</button><button type="button" className="primary" onClick={applyCategoryFilters}>确定</button></div></div></div>}
    {showMoveLedger && <div className="transactions-modal-backdrop" onClick={() => setShowMoveLedger(false)}><div className="transactions-sheet" onClick={(event) => event.stopPropagation()}><div className="transactions-sheet-header"><h2>迁移交易至账本</h2><button type="button" onClick={() => setShowMoveLedger(false)}><X size={19} /></button></div><p className="transactions-sheet-description">请选择要将选中的 {selectedIds.size} 笔交易记录迁移到哪个账本：</p><div className="transactions-ledger-options">{ledgers.map((ledger: Ledger) => <button type="button" key={ledger.id} disabled={ledger.id === activeLedgerId} className={ledger.id === activeLedgerId ? 'current' : ''} onClick={() => { const targetId = ledger.id; if (targetId != null) void moveSelected(targetId); }}><span><strong>{ledger.name}</strong><small>{ledger.type === 'JOINT' ? '合资' : '个人'}</small></span>{ledger.id === activeLedgerId && <small>当前账本</small>}</button>)}</div></div></div>}
    {showDeleteConfirm && <div className="transactions-modal-backdrop" onClick={() => setShowDeleteConfirm(false)}><div className="transactions-confirm" onClick={(event) => event.stopPropagation()}><h2>批量删除</h2><p>确认删除选中的 {selectedIds.size} 笔记录？删除后无法恢复。</p><div className="transactions-sheet-actions"><button type="button" onClick={() => setShowDeleteConfirm(false)}>取消</button><button type="button" className="danger" onClick={() => void deleteSelected()}>删除</button></div></div></div>}
  </div>;
}

function FilterGroup({ label, options, value, onChange }: { label: string; options: Array<[string, string]>; value: string; onChange: (value: string) => void }) {
  return <div className="transactions-filter-group"><h3>{label}</h3><div className="transactions-filter-chips">{options.map(([key, text]) => <button type="button" key={key} className={value === key ? 'selected' : ''} onClick={() => onChange(key)}>{text}</button>)}</div></div>;
}
