import { useMemo, useState } from 'react';
import { ArrowLeft, Check, CloudDownload, RefreshCw, ShieldAlert } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/localDb';
import { applyExpiredOptionCandidates, findExpiredOptionCandidates, type ExpiredOptionCandidate } from '../core/corporateActions/expiredOptionService';
import { applySplitCandidates, buildSplitCandidates, getPendingSplitEvents, syncCorporateActionSplits } from '../core/corporateActions/splitActionService';

function localDate() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

const marketLabel = (market: string) => market === 'US' ? '美股' : market === 'HK' ? '港股' : 'A股';

export default function ExpiredOptionsPage() {
  const navigate = useNavigate();
  const [asOfDate, setAsOfDate] = useState(localDate);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [applying, setApplying] = useState(false);
  const [syncingSplits, setSyncingSplits] = useState(false);
  const [selectedSplits, setSelectedSplits] = useState<string[]>([]);
  const ledgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value, []) ?? 1;
  const liveTransactions = useLiveQuery(async () => ledgerId === 0
    ? db.transactions.toArray()
    : db.transactions.where('ledgerId').equals(ledgerId as number).toArray(), [ledgerId]);
  const transactions = useMemo(() => liveTransactions ?? [], [liveTransactions]);
  const livePendingSplitEvents = useLiveQuery(() => getPendingSplitEvents(ledgerId as number), [ledgerId]);
  const pendingSplitEvents = useMemo(() => livePendingSplitEvents ?? [], [livePendingSplitEvents]);
  const candidates = useMemo(() => findExpiredOptionCandidates(transactions, asOfDate), [transactions, asOfDate]);
  const selectedCandidates = candidates.filter((candidate) => selected.includes(candidate.id));
  const stockSymbols = useMemo(() => [...new Map(transactions
    .filter((transaction) => transaction.assetType === 'STOCK' && ['A_SHARE', 'HK', 'US'].includes(transaction.market))
    .map((transaction) => [`${transaction.market}:${transaction.symbol}`, { symbol: transaction.symbol, market: transaction.market as 'A_SHARE' | 'HK' | 'US' }])).values()], [transactions]);
  const splitCandidates = useMemo(() => buildSplitCandidates(transactions, pendingSplitEvents), [transactions, pendingSplitEvents]);
  const selectedSplitCandidates = splitCandidates.filter((candidate) => selectedSplits.includes(candidate.id));

  const toggle = (candidate: ExpiredOptionCandidate) => {
    setSelected((current) => current.includes(candidate.id)
      ? current.filter((id) => id !== candidate.id)
      : [...current, candidate.id]);
  };

  const apply = async () => {
    if (!selectedCandidates.length || applying) return;
    const confirmed = window.confirm(`将为 ${selectedCandidates.length} 个期权仓位创建“期权到期”记录。\n\n仅当期权确实作废、且没有行权或被指派时确认。若已行权/指派，请取消并手工录入实际结算。`);
    if (!confirmed) return;
    setApplying(true);
    setMessage('');
    try {
      const count = await applyExpiredOptionCandidates(selectedCandidates);
      setSelected([]);
      setMessage(count ? `已创建 ${count} 条期权到期记录。` : '选中的候选项已处理，无需重复写入。');
    } catch (error) {
      setMessage(`写入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setApplying(false);
    }
  };

  const syncSplits = async () => {
    if (syncingSplits || !stockSymbols.length) return;
    setSyncingSplits(true);
    setMessage('');
    try {
      const result = await syncCorporateActionSplits({ ledgerId: ledgerId as number, force: true });
      setSelectedSplits([]);
      setMessage(result.failures.length ? `同步完成，但部分市场失败：${result.failures.join('；')}` : result.events.length ? `已同步 ${result.events.length} 条拆并股事件，请在下方确认候选。` : '同步完成，没有发现新的拆并股事件。');
    } catch (error) {
      setMessage(`同步公司行动失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSyncingSplits(false);
    }
  };

  const applySplits = async () => {
    if (!selectedSplitCandidates.length || applying) return;
    if (!window.confirm(`将为 ${selectedSplitCandidates.length} 条平台流水创建拆并股记录。\n\n请确认这些事件已经实施，并且除权日、比例与券商结单一致。`)) return;
    setApplying(true);
    setMessage('');
    try {
      const count = await applySplitCandidates(selectedSplitCandidates);
      setSelectedSplits([]);
      setMessage(count ? `已创建 ${count} 条拆并股记录。` : '选中的拆并股候选项已处理，无需重复写入。');
    } catch (error) {
      setMessage(`写入拆并股失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setApplying(false);
    }
  };

  return <div className="page secondary-page data-corporate-actions-page">
    <header className="secondary-page-header"><button type="button" className="icon-button" onClick={() => navigate('/data')} aria-label="返回数据"><ArrowLeft size={22} /></button><h1>公司行动</h1><span /></header>
    <section className="surface-card">
      <div className="section-heading"><span><CloudDownload size={18} />股票拆并股同步</span><button type="button" className="icon-button" onClick={() => void syncSplits()} disabled={syncingSplits || !stockSymbols.length} aria-label="同步拆并股"><RefreshCw size={17} className={syncingSplits ? 'spin' : undefined} /></button></div>
      <p className="text-sm text-muted">A 股使用 stock-sdk 的东方财富送转数据；港股、美股使用 Yahoo Chart 的免费 splits 事件。同步只生成候选，不会自动改账本。</p>
      <button type="button" className="primary" onClick={() => void syncSplits()} disabled={syncingSplits || !stockSymbols.length}>{syncingSplits ? '同步中…' : stockSymbols.length ? `同步 ${stockSymbols.length} 个股票标的` : '当前账本没有股票标的'}</button>
      {splitCandidates.length > 0 && <>
        <section className="surface-list corporate-action-candidate-list">
          {splitCandidates.map((candidate) => <label key={candidate.id} className={`list-row corporate-action-candidate ${selectedSplits.includes(candidate.id) ? 'selected' : ''}`}>
            <input type="checkbox" checked={selectedSplits.includes(candidate.id)} onChange={() => setSelectedSplits((current) => current.includes(candidate.id) ? current.filter((id) => id !== candidate.id) : [...current, candidate.id])} />
            <span className="list-row-main"><strong>{candidate.name || candidate.symbol}</strong><small>{candidate.symbol} · {marketLabel(candidate.market)} · {candidate.platform}</small><small>除权日 {candidate.tradeDate} · 比例 {candidate.ratio} · {candidate.detail}</small></span>
          </label>)}
        </section>
        <div className="corporate-action-inline-actions"><button type="button" onClick={() => setSelectedSplits(selectedSplits.length === splitCandidates.length ? [] : splitCandidates.map((candidate) => candidate.id))}>{selectedSplits.length === splitCandidates.length ? '取消全选' : '全选拆并股'}</button><button type="button" className="primary" disabled={!selectedSplitCandidates.length || applying} onClick={() => void applySplits()}>{applying ? '写入中…' : `确认拆并股 (${selectedSplitCandidates.length})`}</button></div>
      </>}
    </section>
    <section className="surface-card">
      <div className="section-heading"><span><ShieldAlert size={18} />本地候选扫描</span><button type="button" className="icon-button" onClick={() => setAsOfDate(localDate())} aria-label="刷新扫描日期"><RefreshCw size={17} /></button></div>
      <p className="text-sm text-muted">只扫描已过期且仍有净仓位的期权，不会自动写入账本。请先确认没有行权或指派。</p>
      <label className="trade-form-field"><span className="trade-form-label">扫描截至日期</span><input type="date" value={asOfDate} onChange={(event) => { setAsOfDate(event.target.value); setSelected([]); }} /></label>
    </section>
    {candidates.length === 0 ? <div className="data-page-note"><Check size={18} />截至 {asOfDate} 没有待确认的过期期权仓位。</div> : <>
      <section className="surface-list corporate-action-candidate-list">
        {candidates.map((candidate) => <label key={candidate.id} className={`list-row corporate-action-candidate ${selected.includes(candidate.id) ? 'selected' : ''}`}>
          <input type="checkbox" checked={selected.includes(candidate.id)} onChange={() => toggle(candidate)} />
          <span className="list-row-main"><strong>{candidate.name || candidate.symbol}</strong><small>{candidate.symbol} · {marketLabel(candidate.market)} · {candidate.platform}</small><small>到期 {candidate.expiryDate}{candidate.optionType ? ` · ${candidate.optionType === 'CALL' ? 'Call' : 'Put'}` : ''}{candidate.strikePrice == null ? '' : ` · 行权价 ${candidate.strikePrice}`}</small></span>
          <span className="text-muted">{candidate.netQuantity > 0 ? '多' : '空'} {candidate.quantity}</span>
        </label>)}
      </section>
      <div className="trade-form-actions"><button type="button" onClick={() => setSelected(selected.length === candidates.length ? [] : candidates.map((candidate) => candidate.id))}>{selected.length === candidates.length ? '取消全选' : '全选'}</button><button type="button" className="primary" disabled={!selectedCandidates.length || applying} onClick={() => void apply()}>{applying ? '写入中…' : `确认作废 (${selectedCandidates.length})`}</button></div>
    </>}
    {message && <div className={message.startsWith('写入失败') ? 'error data-page-note' : 'data-page-note'}>{message}</div>}
  </div>;
}
