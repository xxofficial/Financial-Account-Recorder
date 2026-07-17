import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Briefcase, ChevronDown, ChevronRight, ChevronUp, Database, Download, FileText, Plus, RefreshCw, Settings, SlidersHorizontal, Trash2, TrendingUp } from 'lucide-react';
import { db } from '../db/localDb';
import type { Ledger } from '../db/schema';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import { marketCacheManager } from '../core/market/marketCacheManager';
import { cacheService } from '../core/market/marketDataCacheService';
import { isAndroidNativeRuntime, nativeAppUpdate, type NativeAppUpdate } from '../platform/nativeRuntime';
import { BrokerPlatform, CurrencyType, DisplayCurrency, PlatformType } from '../shared/models';
import { ExchangeRates, PortfolioCalculator } from '../core/portfolio/portfolioCalculator';
import { analysisRuntimeCache } from '../core/portfolio/analysisRuntime';
import { useEdgeSwipeBack } from '../components/SecondaryPageHeader';
import { syncCorporateActionsOnAppOpen } from '../core/corporateActions/splitActionService';

interface AppShellProps { children: React.ReactNode; }
type RefreshAction = (() => Promise<void>) | undefined;

interface AppShellContextValue {
  registerPortfolioRefresh: (action: RefreshAction) => void;
  activePlatform: PlatformType | null;
  selectPlatform: (platform: PlatformType | null) => Promise<void>;
  enabledPlatforms: PlatformType[];
  setPlatformVisibility: (platform: PlatformType, enabled: boolean) => Promise<void>;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAppShell() {
  const context = useContext(AppShellContext);
  if (!context) throw new Error('useAppShell must be used inside AppShell');
  return context;
}

type AutoSyncSetting = 'auto_sync_after_import' | 'auto_sync_after_transaction' | 'auto_sync_daily_close';
const AUTO_SYNC_SETTINGS: AutoSyncSetting[] = ['auto_sync_after_import', 'auto_sync_after_transaction', 'auto_sync_daily_close'];
const TAB_ROUTES = new Set(['/', '/analysis', '/data', '/transactions']);
const calculator = new PortfolioCalculator();
const drawerRates: ExchangeRates = { usdToCny: 7.2, hkdToCny: .92 };
const configurablePlatforms = Object.values(BrokerPlatform).filter((platform) => platform.isConfigurable).map((platform) => platform.code);
const platformIconNames: Partial<Record<PlatformType, string>> = {
  ALIPAY: 'alipay', EAST_MONEY: 'east_money', LONGBRIDGE: 'longbridge', HSBC: 'hsbc',
  USMART: 'usmart', ZHUORUI: 'zhuorui', CHIEF: 'chief', SCHWAB: 'schwab',
};

async function prepareMarketSyncOnAppOpen() {
  // Web and Android now both have keyless stock-sdk coverage for stocks.
  // Keep the defaults aligned, while preserving any explicit user choice.
  const defaultEnabled = true;
  const values = await Promise.all(AUTO_SYNC_SETTINGS.map((key) => db.appSettings.get(key)));
  for (let index = 0; index < AUTO_SYNC_SETTINGS.length; index += 1) {
    if (!values[index]) await db.appSettings.put({ key: AUTO_SYNC_SETTINGS[index], value: defaultEnabled, updatedAt: Date.now() });
  }
  const dailyEnabled = Boolean(values[2]?.value ?? defaultEnabled);
  if (dailyEnabled) await cacheService.triggerDailyCloseUpdate();
  // Import/transaction settings are event-specific and are handled by their
  // respective workflows.  Starting the app only checks the optional daily
  // close setting, so it cannot requeue a full history range every launch.
  if (dailyEnabled) await MarketTaskExecutor.startOrWakeMarketExecutor();
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
  const { activePlatform, selectPlatform, enabledPlatforms, setPlatformVisibility } = useAppShell();
  const [showVisibilitySettings, setShowVisibilitySettings] = useState(false);
  const [ledgerEditorOpen, setLedgerEditorOpen] = useState(false);
  const [ledgerName, setLedgerName] = useState('');
  const [ledgerDescription, setLedgerDescription] = useState('');
  const [ledgerType, setLedgerType] = useState<Ledger['type']>('PERSONAL');
  const [ledgerPartners, setLedgerPartners] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const ledgers = useLiveQuery(() => db.ledgers.toArray()) ?? [];
  const selectedLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value) ?? 1;
  const transactions = useLiveQuery(async () => selectedLedgerId === 0 ? db.transactions.toArray() : db.transactions.where('ledgerId').equals(selectedLedgerId as number).toArray(), [selectedLedgerId]) ?? [];
  const quotes = useLiveQuery(() => db.quoteSnapshots.toArray()) ?? [];
  const storedCurrency = useLiveQuery(async () => (await db.appSettings.get('display_currency'))?.value) ?? 'CNY';
  const displayCurrency = DisplayCurrency[storedCurrency as CurrencyType] ?? DisplayCurrency.CNY;
  const selectLedger = async (ledgerId: number) => { await db.appSettings.put({ key: 'default_ledger', value: ledgerId, updatedAt: Date.now() }); close(); };
  const createLedger = async () => {
    if (!ledgerName.trim()) return;
    const now = Date.now();
    const id = await db.ledgers.add({ name: ledgerName.trim(), type: ledgerType, description: ledgerDescription.trim(), partners: ledgerType === 'JOINT' ? ledgerPartners.split(',').map((item) => item.trim()).filter(Boolean).join(',') : '', createdAt: now, updatedAt: now });
    await db.appSettings.put({ key: 'default_ledger', value: id, updatedAt: now });
    setLedgerName(''); setLedgerDescription(''); setLedgerType('PERSONAL'); setLedgerPartners(''); setLedgerEditorOpen(false);
  };
  const deleteLedger = async (ledgerId: number, name: string) => {
    setDeleteTarget({ id: ledgerId, name });
  };
  const confirmDeleteLedger = async () => {
    if (!deleteTarget) return;
    const { id: ledgerId } = deleteTarget;
    const fallbackLedgerId = ledgers.find((ledger) => ledger.id !== ledgerId)?.id ?? 1;
    await db.transaction('rw', [db.ledgers, db.transactions], async () => {
      await db.transactions.where('ledgerId').equals(ledgerId).delete();
      await db.ledgers.delete(ledgerId);
    });
    if (selectedLedgerId === ledgerId) await db.appSettings.put({ key: 'default_ledger', value: fallbackLedgerId, updatedAt: Date.now() });
    setDeleteTarget(null);
  };
  const platforms = enabledPlatforms;
  const formatAssets = (valueCny: number) => `${displayCurrency.symbol}${(valueCny / displayCurrency.cnyRate).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const summaryAssets = calculator.calculate(transactions, quotes, drawerRates).totalAssetsCny;
  const typeLabel = (type: string) => type === 'PERSONAL' ? '个人' : type === 'JOINT' ? '合资' : type === 'MANAGED' ? '代操' : type;

  return <><div className="drawer-backdrop" onClick={close} /><aside className="ledger-drawer android-drawer">
    <section className="android-drawer-section">
      <div className="android-drawer-title-row"><h2>我的账本</h2><button className="drawer-create-button" onClick={() => setLedgerEditorOpen(true)}>＋ 新建账本</button></div>
      <p>在不同账本间切换以隔离数据。合资账本可记录共有人和实际出资人。</p>
      <div className="android-drawer-card">{ledgers.map((ledger) => {
        const selected = ledger.id === selectedLedgerId;
        return <div key={ledger.id} className={`android-ledger-row ${selected ? 'selected' : ''}`} role="button" tabIndex={0} onClick={() => void selectLedger(ledger.id!)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void selectLedger(ledger.id!); } }}><span className="android-ledger-copy"><span><strong>{ledger.name}</strong><em className={`ledger-type ${ledger.type.toLowerCase()}`}>{typeLabel(ledger.type)}</em></span>{ledger.description && <small>{ledger.description}</small>}</span><span className="android-ledger-actions">{selected && <span>当前</span>}{ledger.id !== 1 && <button aria-label={`删除账本 ${ledger.name}`} className="drawer-delete" onClick={(event) => { event.stopPropagation(); void deleteLedger(ledger.id!, ledger.name); }}><Trash2 size={20} /></button>}</span></div>;
      })}</div>
    </section>
    <div className="android-drawer-divider" />
    <section className="android-drawer-section">
      <h2>交易平台</h2><p>侧边栏切换后，持仓、盈亏和流水会同步显示对应平台的数据。</p><span className="android-drawer-caption">当前显示</span>
      <div className="android-drawer-card android-platform-list">
        <button className={`android-platform-row ${activePlatform === null ? 'selected' : ''}`} onClick={() => void selectPlatform(null).then(close)}><PlatformMark /><span className="android-platform-copy"><strong>汇总</strong><small>总资产 {formatAssets(summaryAssets)}</small></span>{activePlatform === null && <span>当前</span>}</button>
        {platforms.map((platform) => {
          const assets = calculator.calculate(transactions.filter((transaction) => transaction.platform === platform), quotes, drawerRates).totalAssetsCny;
          return <button key={platform} className={`android-platform-row ${activePlatform === platform ? 'selected' : ''}`} onClick={() => void selectPlatform(platform).then(close)}><PlatformMark platform={platform} /><span className="android-platform-copy"><strong>{BrokerPlatform[platform].label}</strong><small>总资产 {formatAssets(assets)}</small></span>{activePlatform === platform && <span>当前</span>}</button>;
        })}
      </div>
    </section>
    <section className="android-display-settings">
      <button onClick={() => setShowVisibilitySettings((show) => !show)}><span><strong>显示设置</strong><small>管理侧边栏展示的平台</small></span>{showVisibilitySettings ? <ChevronUp size={20} /> : <ChevronDown size={20} />}</button>
      {showVisibilitySettings && <div className="android-display-settings-body">
        <p>这里只影响侧边栏展示和录入页的平台选项，不会删除任何交易数据。至少保留一个平台。</p>
        {configurablePlatforms.map((platform) => {
          const assets = calculator.calculate(transactions.filter((transaction) => transaction.platform === platform), quotes, drawerRates).totalAssetsCny;
          const enabled = enabledPlatforms.includes(platform);
          return <label className="platform-visibility-row" key={platform}><PlatformMark platform={platform} /><span><strong>{BrokerPlatform[platform].label}</strong><small>总资产 {formatAssets(assets)}</small></span><input type="checkbox" checked={enabled} disabled={enabled && enabledPlatforms.length === 1} onChange={(event) => void setPlatformVisibility(platform, event.target.checked)} /></label>;
        })}
      </div>}
    </section>
  </aside>
  {ledgerEditorOpen && <div className="action-sheet-backdrop" role="presentation" onClick={() => setLedgerEditorOpen(false)}><div className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="ledger-editor-title" onClick={(event) => event.stopPropagation()}>
    <h2 id="ledger-editor-title">新建账本</h2>
    <label className="form-field"><span>账本名称</span><input autoFocus value={ledgerName} onChange={(event) => setLedgerName(event.target.value)} placeholder="例如：家庭投资" /></label>
    <label className="form-field"><span>账本类型</span><select value={ledgerType} onChange={(event) => setLedgerType(event.target.value as Ledger['type'])}><option value="PERSONAL">个人账本</option><option value="JOINT">合资账本</option></select></label>
    <label className="form-field"><span>说明（可选）</span><input value={ledgerDescription} onChange={(event) => setLedgerDescription(event.target.value)} placeholder="用于区分不同用途" /></label>
    {ledgerType === 'JOINT' && <label className="form-field"><span>共有人</span><input value={ledgerPartners} onChange={(event) => setLedgerPartners(event.target.value)} placeholder="用逗号分隔，例如：我,小明" /><small>入金或撤资时可选择实际出资人。</small></label>}
    <div className="action-sheet-actions"><button type="button" onClick={() => setLedgerEditorOpen(false)}>取消</button><button type="button" className="primary" disabled={!ledgerName.trim() || (ledgerType === 'JOINT' && !ledgerPartners.trim())} onClick={() => void createLedger()}>创建账本</button></div>
  </div></div>}
  {deleteTarget && <div className="action-sheet-backdrop" role="presentation" onClick={() => setDeleteTarget(null)}><div className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="delete-ledger-title" onClick={(event) => event.stopPropagation()}>
    <h2 id="delete-ledger-title">删除账本？</h2><p>将删除“{deleteTarget.name}”及其中的交易记录。此操作不可撤销，请确认已有备份。</p><div className="action-sheet-actions"><button type="button" onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="danger" onClick={() => void confirmDeleteLedger()}>删除账本</button></div>
  </div></div>}
  </>;
}

export function PlatformMark({ platform, className }: { platform?: PlatformType; className?: string }) {
  const iconName = platform ? platformIconNames[platform] : undefined;
  // Do not use a root-relative URL here: GitHub Pages hosts this app below the
  // repository path, so `/platform_*.png` points outside the deployed app.
  const iconSrc = iconName ? `${import.meta.env.BASE_URL}platform_${iconName}.png` : undefined;
  return <span className={`platform-mark ${platform?.toLowerCase() ?? 'summary'} ${className ?? ''}`}>{iconSrc ? <img src={iconSrc} alt="" /> : platform ? BrokerPlatform[platform].shortLabel : '汇'}</span>;
}

function GlobalTopBar({ onOpenDrawer, onRefresh, refreshing }: { onOpenDrawer: () => void; onRefresh?: () => void; refreshing: boolean }) {
  const navigate = useNavigate();
  const { activePlatform } = useAppShell();
  const selectedLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value) ?? 1;
  const ledger = useLiveQuery(() => selectedLedgerId === 0 ? undefined : db.ledgers.get(selectedLedgerId as number), [selectedLedgerId]);
  const platformLabel = activePlatform === null ? '汇总' : BrokerPlatform[activePlatform].label;
  const scopeTitle = selectedLedgerId === 0 ? '汇总' : ledger?.name ?? '默认个人账本';

  return <header className="global-top-bar">
    <button className="global-top-bar-scope" onClick={onOpenDrawer} aria-label="平台与账本">
      <PlatformMark platform={activePlatform ?? undefined} className="global-top-bar-badge" />
      <span className="global-top-bar-copy"><h1>{scopeTitle}</h1><span>{platformLabel}</span></span>
      <SlidersHorizontal size={20} aria-hidden="true" />
    </button>
    <div className="global-top-bar-actions">
      {onRefresh && <button className="icon-button" onClick={onRefresh} disabled={refreshing} aria-label="刷新行情"><RefreshCw size={22} className={refreshing ? 'spin' : ''} /></button>}
      <button className="icon-button" onClick={() => navigate('/settings')} aria-label="设置"><Settings size={24} /></button>
    </div>
  </header>;
}

function RecordActionSheet({ close }: { close: () => void }) {
  const navigate = useNavigate();
  const open = (type: string) => { navigate(`/transactions/new?type=${type}`); close(); };
  const groups = [
    ['证券交易', [['BUY', '买入证券'], ['SELL', '卖出证券']]],
    ['资金操作', [['DEPOSIT', '入金'], ['WITHDRAW', '出金'], ['TRANSFER_OUT&paired=1', '平台间转仓'], ['FX_CONVERSION', '货币兑换']]],
    ['公司行动与其他', [['DIVIDEND', '股息'], ['TAX', '税费'], ['INTEREST', '融资利息'], ['SPLIT', '拆股'], ['EXPIRE', '期权到期'], ['OTHER', '其他']]],
  ];
  return <div className="action-sheet-backdrop" onClick={close}><div className="action-sheet" role="dialog" aria-modal="true" aria-label="记一笔" onClick={(event) => event.stopPropagation()}>
    <div className="action-sheet-scroll">
      {groups.map(([title, actions]) => <section key={title as string} className="action-sheet-group"><div className="text-xs text-muted action-sheet-group-title">{title as string}</div><div className="surface-list">{(actions as string[][]).map(([type, label]) => <button key={type} className="list-row" onClick={() => open(type)}><span className="list-row-main"><span className="list-row-title">{label}</span></span><ChevronRight size={18} /></button>)}</div></section>)}
    </div>
    <button className="action-sheet-cancel" onClick={close}>取消</button>
  </div></div>;
}

export default function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false); const [recordOpen, setRecordOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<NativeAppUpdate | null>(null);
  const [portfolioRefresh, setPortfolioRefresh] = useState<RefreshAction>();
  const [refreshing, setRefreshing] = useState(false);
  const marketScheme = useLiveQuery(async () => (await db.appSettings.get('candlestick_color_scheme'))?.value) ?? 'red_up';
  const themePreference = useLiveQuery(async () => (await db.appSettings.get('theme_preference'))?.value) ?? 'system';
  const selectedPlatformValue = useLiveQuery(async () => (await db.appSettings.get('selected_platform'))?.value) ?? null;
  const enabledPlatformsValue = useLiveQuery(async () => (await db.appSettings.get('enabled_platforms'))?.value);
  const selectedLedgerId = useLiveQuery(async () => (await db.appSettings.get('default_ledger'))?.value) ?? 1;
  const activePlatform = typeof selectedPlatformValue === 'string' && selectedPlatformValue in BrokerPlatform
    ? selectedPlatformValue as PlatformType
    : null;
  const enabledPlatforms = Array.isArray(enabledPlatformsValue)
    ? configurablePlatforms.filter((platform) => enabledPlatformsValue.includes(platform))
    : configurablePlatforms;
  const isTopLevelTab = TAB_ROUTES.has(location.pathname);
  const secondaryFallback = location.pathname.startsWith('/analysis/') ? '/analysis'
    : location.pathname.startsWith('/data/') ? '/data'
      : location.pathname.startsWith('/transactions/') ? '/transactions' : '/';
  const registerPortfolioRefresh = useCallback((action: RefreshAction) => setPortfolioRefresh(() => action), []);
  const selectPlatform = useCallback(async (platform: PlatformType | null) => {
    await db.appSettings.put({ key: 'selected_platform', value: platform, updatedAt: Date.now() });
  }, []);
  const setPlatformVisibility = useCallback(async (platform: PlatformType, enabled: boolean) => {
    const next = enabled
      ? configurablePlatforms.filter((candidate) => candidate === platform || enabledPlatforms.includes(candidate))
      : enabledPlatforms.filter((candidate) => candidate !== platform);
    if (next.length === 0) return;
    await db.appSettings.put({ key: 'enabled_platforms', value: next, updatedAt: Date.now() });
    if (!enabled && activePlatform === platform) await db.appSettings.put({ key: 'selected_platform', value: null, updatedAt: Date.now() });
  }, [activePlatform, enabledPlatforms]);
  const refreshPortfolio = async () => {
    if (!portfolioRefresh || refreshing) return;
    setRefreshing(true);
    try { await portfolioRefresh(); } finally { setRefreshing(false); }
  };
  useEdgeSwipeBack(!isTopLevelTab && !drawerOpen && !recordOpen && !availableUpdate, () => {
    const historyState = window.history.state as { idx?: number } | null;
    if (typeof historyState?.idx === 'number' && historyState.idx > 0) navigate(-1);
    else navigate(secondaryFallback, { replace: true });
  });
  useEffect(() => { document.documentElement.dataset.marketScheme = marketScheme === 'green_up' ? 'green_up' : 'red_up'; }, [marketScheme]);
  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      const preference = themePreference === 'light' || themePreference === 'dark' ? themePreference : 'system';
      root.dataset.theme = preference;
      root.style.colorScheme = preference === 'system' ? '' : preference;
    };
    applyTheme();
    if (themePreference !== 'system' || !window.matchMedia) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, [themePreference]);
  useEffect(() => {
    void prepareMarketSyncOnAppOpen().catch((error) => console.warn('行情启动检查失败', error));
    void syncCorporateActionsOnAppOpen().catch((error) => console.warn('公司行动启动检查失败', error));
  }, []);
  useEffect(() => {
    if (typeof selectedLedgerId !== 'number') return;
    const timer = window.setTimeout(() => {
      analysisRuntimeCache.warm({ ledgerId: selectedLedgerId, platform: activePlatform });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [activePlatform, selectedLedgerId]);
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
  return <AppShellContext.Provider value={{ registerPortfolioRefresh, activePlatform, selectPlatform, enabledPlatforms, setPlatformVisibility }}><div className="app-container"><main className="app-main">
    {isTopLevelTab && <GlobalTopBar onOpenDrawer={() => setDrawerOpen(true)} onRefresh={location.pathname === '/' ? () => void refreshPortfolio() : undefined} refreshing={refreshing} />}
    {isTopLevelTab && <MarketSyncCard />}
    {children}
  </main>
    {isTopLevelTab && <nav className="bottom-tab-bar">{navItems.slice(0, 2).map((item) => <NavLink key={item.path} to={item.path} className={({ isActive }) => `bottom-tab-item ${isActive ? 'active' : ''}`}>{item.icon}<span>{item.label}</span></NavLink>)}
      <div className="bottom-plus-wrap"><button className="bottom-plus" onClick={() => setRecordOpen(true)} aria-label="记一笔"><Plus size={28} /></button></div>
      {navItems.slice(2).map((item) => <NavLink key={item.path} to={item.path} className={({ isActive }) => `bottom-tab-item ${isActive ? 'active' : ''}`}>{item.icon}<span>{item.label}</span></NavLink>)}</nav>}
    {drawerOpen && <LedgerDrawer close={() => setDrawerOpen(false)} />}{recordOpen && <RecordActionSheet close={() => setRecordOpen(false)} />}
    {availableUpdate && <div className="action-sheet-backdrop"><div className="action-sheet"><h2 className="page-title">发现新版本</h2><p className="text-sm text-muted">{availableUpdate.latestVersionName || 'GitHub Release'} · {availableUpdate.assetName}</p><div style={{ display: 'flex', gap: 8 }}><button className="primary" style={{ flex: 1 }} onClick={() => void installUpdate()}>下载并安装</button><button style={{ flex: 1 }} onClick={() => setAvailableUpdate(null)}>稍后</button></div></div></div>}
  </div></AppShellContext.Provider>;
}
