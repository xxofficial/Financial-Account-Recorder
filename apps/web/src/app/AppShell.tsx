import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, BarChart3, Briefcase, ChevronRight, Database, Download, FileText, Layers, Plus, RefreshCw, TrendingUp } from 'lucide-react';
import { db } from '../db/localDb';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import { marketCacheManager } from '../core/market/marketCacheManager';
import { cacheService } from '../core/market/marketDataCacheService';
import { isAndroidNativeRuntime, nativeAppUpdate, type NativeAppUpdate } from '../platform/nativeRuntime';

interface AppShellProps { children: React.ReactNode; }

type AutoSyncSetting = 'auto_sync_after_import' | 'auto_sync_after_transaction' | 'auto_sync_daily_close';
const AUTO_SYNC_SETTINGS: AutoSyncSetting[] = ['auto_sync_after_import', 'auto_sync_after_transaction', 'auto_sync_daily_close'];

async function prepareMarketSyncOnAppOpen() {
  const defaultEnabled = isAndroidNativeRuntime();
  const values = await Promise.all(AUTO_SYNC_SETTINGS.map((key) => db.appSettings.get(key)));
  for (let index = 0; index < AUTO_SYNC_SETTINGS.length; index += 1) {
    if (!values[index]) await db.appSettings.put({ key: AUTO_SYNC_SETTINGS[index], value: defaultEnabled, updatedAt: Date.now() });
  }
  const historicalEnabled = Boolean(values[0]?.value ?? defaultEnabled) || Boolean(values[1]?.value ?? defaultEnabled);
  const dailyEnabled = Boolean(values[2]?.value ?? defaultEnabled);
  if (historicalEnabled) await marketCacheManager.detectAndQueueMissingRanges();
  if (dailyEnabled) {
    await cacheService.triggerDailyCloseUpdate();
  }
  if (historicalEnabled || dailyEnabled) await MarketTaskExecutor.startOrWakeMarketExecutor();
}

function MarketSyncCard() {
  const [isStarting, setIsStarting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const stats = useLiveQuery(async () => {
    const items = await db.marketWorkItems.toArray();
    const active = items.filter((item) => ['historical_range_fill', 'daily_close_update'].includes(item.kind) && ['pending', 'running', 'retry_scheduled', 'paused_quota', 'paused_provider_error'].includes(item.status));
    return { total: active.length, running: active.filter((item) => item.status === 'running').length };
  }) ?? { total: 0, running: 0 };

  if (stats.total === 0) return null;
  const syncNow = async () => { setIsStarting(true); try { await MarketTaskExecutor.startOrWakeMarketExecutor(); } finally { setIsStarting(false); } };
  const exportMissing = async () => {
    setIsExporting(true);
    try {
      const { blob, fileName } = await marketCacheManager.exportMissingMarketData();
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = fileName; link.click(); URL.revokeObjectURL(url);
    } finally { setIsExporting(false); }
  };
  return <section className="sync-card">
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 700 }}>
      {stats.running > 0 ? <RefreshCw className="spin" size={16} /> : <AlertTriangle size={16} />}
      {stats.running > 0 ? `正在补齐 ${stats.total} 项历史行情` : `有 ${stats.total} 项历史行情待补齐`}
    </div>
    <div className="text-xs text-muted" style={{ marginTop: 4 }}>仅影响持仓期间的历史行情；实时价格请在持仓页手动刷新。</div>
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <button className="primary" onClick={() => void syncNow()} disabled={isStarting || stats.running > 0} style={{ minHeight: 34, fontSize: 12 }}>{isStarting ? <RefreshCw size={14} className="spin" /> : <RefreshCw size={14} />}立即同步</button>
      <button onClick={() => void exportMissing()} disabled={isExporting} style={{ minHeight: 34, fontSize: 12 }}><Download size={14} />导出缺失信息</button>
    </div>
  </section>;
}

function LedgerDrawer({ close }: { close: () => void }) {
  const ledgers = useLiveQuery(() => db.ledgers.toArray()) ?? [];
  const selected = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value) ?? 1;
  const select = async (ledgerId: number) => { await db.appSettings.put({ key: 'default_ledger', value: ledgerId, updatedAt: Date.now() }); close(); };
  return <><div className="drawer-backdrop" onClick={close} /><aside className="ledger-drawer">
    <h2 className="page-title">平台与账本</h2>
    <p className="text-sm text-muted">选择汇总视图或一个账本</p>
    <div className="surface-list">
      <button className="list-row" onClick={() => void select(0)}><Layers size={20} /><span className="list-row-main"><span className="list-row-title">账本汇总</span><span className="list-row-desc">查看所有已启用账本</span></span>{selected === 0 && '✓'}</button>
      {ledgers.map((ledger) => <button key={ledger.id} className="list-row" onClick={() => void select(ledger.id!)}><Briefcase size={20} /><span className="list-row-main"><span className="list-row-title">{ledger.name}</span><span className="list-row-desc">{ledger.type === 'PERSONAL' ? '个人账本' : ledger.type}</span></span>{selected === ledger.id && '✓'}</button>)}
    </div>
  </aside></>;
}

function RecordActionSheet({ close }: { close: () => void }) {
  const navigate = useNavigate();
  const open = (type: string) => { navigate(`/transactions/new?type=${type}`); close(); };
  const groups = [
    ['证券交易', [['BUY', '买入证券'], ['SELL', '卖出证券']]],
    ['资金操作', [['DEPOSIT', '入金'], ['WITHDRAW', '出金'], ['TRANSFER_IN', '转入'], ['TRANSFER_OUT', '转出'], ['FX_CONVERSION', '货币兑换']]],
    ['公司行动与其他', [['DIVIDEND', '股息'], ['TAX', '税费'], ['INTEREST', '利息'], ['SPLIT', '拆股'], ['EXPIRE', '期权到期'], ['OTHER', '其他']]],
  ];
  return <div className="action-sheet-backdrop" onClick={close}><div className="action-sheet" onClick={(event) => event.stopPropagation()}>
    {groups.map(([title, actions]) => <section key={title as string} style={{ marginBottom: 16 }}><div className="text-xs text-muted" style={{ margin: '0 0 6px 4px' }}>{title as string}</div><div className="surface-list">{(actions as string[][]).map(([type, label]) => <button key={type} className="list-row" onClick={() => open(type)}><span className="list-row-main"><span className="list-row-title">{label}</span></span><ChevronRight size={18} /></button>)}</div></section>)}
    <button onClick={close} style={{ width: '100%' }}>取消</button>
  </div></div>;
}

export default function AppShell({ children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false); const [recordOpen, setRecordOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<NativeAppUpdate | null>(null);
  const marketScheme = useLiveQuery(async () => (await db.appSettings.get('candlestick_color_scheme'))?.value) ?? 'red_up';
  useEffect(() => { document.documentElement.dataset.marketScheme = marketScheme === 'green_up' ? 'green_up' : 'red_up'; }, [marketScheme]);
  useEffect(() => { void prepareMarketSyncOnAppOpen().catch((error) => console.warn('行情启动检查失败', error)); }, []);
  useEffect(() => {
    if (!isAndroidNativeRuntime()) return;
    void nativeAppUpdate.check().then((result) => { if (result.hasUpdate) setAvailableUpdate(result); }).catch(() => undefined);
  }, []);
  const installUpdate = async () => {
    if (!availableUpdate?.downloadUrl || !availableUpdate.assetName) return;
    await nativeAppUpdate.downloadAndInstall({ downloadUrl: availableUpdate.downloadUrl, assetName: availableUpdate.assetName });
  };
  const navItems = [
    { path: '/', label: '持仓', icon: <Briefcase size={20} /> },
    { path: '/analysis', label: '分析', icon: <TrendingUp size={20} /> },
    { path: '/data', label: '数据', icon: <Database size={20} /> },
    { path: '/transactions', label: '流水', icon: <FileText size={20} /> },
  ];
  return <div className="app-container"><main className="app-main"><MarketSyncCard />{children}</main>
    <nav className="bottom-tab-bar">{navItems.slice(0, 2).map((item) => <NavLink key={item.path} to={item.path} className={({ isActive }) => `bottom-tab-item ${isActive ? 'active' : ''}`}>{item.icon}<span>{item.label}</span></NavLink>)}
      <div className="bottom-plus-wrap"><button className="bottom-plus" onClick={() => setRecordOpen(true)} aria-label="记一笔"><Plus size={28} /></button></div>
      {navItems.slice(2).map((item) => <NavLink key={item.path} to={item.path} className={({ isActive }) => `bottom-tab-item ${isActive ? 'active' : ''}`}>{item.icon}<span>{item.label}</span></NavLink>)}</nav>
    {drawerOpen && <LedgerDrawer close={() => setDrawerOpen(false)} />}{recordOpen && <RecordActionSheet close={() => setRecordOpen(false)} />}
    {availableUpdate && <div className="action-sheet-backdrop"><div className="action-sheet"><h2 className="page-title">发现新版本</h2><p className="text-sm text-muted">{availableUpdate.latestVersionName || 'GitHub Release'} · {availableUpdate.assetName}</p><div style={{ display: 'flex', gap: 8 }}><button className="primary" style={{ flex: 1 }} onClick={() => void installUpdate()}>下载并安装</button><button style={{ flex: 1 }} onClick={() => setAvailableUpdate(null)}>稍后</button></div></div></div>}
  </div>;
}

export function AppTopActions({ onRefresh, refreshing }: { onRefresh?: () => void; refreshing?: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(false); const navigate = useNavigate();
  return <><div style={{ display: 'flex', gap: 2 }}><button className="icon-button" onClick={() => setDrawerOpen(true)} aria-label="平台与账本"><Layers size={21} /></button>{onRefresh && <button className="icon-button" onClick={onRefresh} disabled={refreshing} aria-label="刷新行情"><RefreshCw size={21} className={refreshing ? 'spin' : ''} /></button>}<button className="icon-button" onClick={() => navigate('/settings')} aria-label="设置"><BarChart3 size={21} /></button></div>{drawerOpen && <LedgerDrawer close={() => setDrawerOpen(false)} />}</>;
}
