import { useEffect, useState } from 'react';
import { Check, ChevronRight, Database, Key, ShieldAlert } from 'lucide-react';
import { db } from '../db/localDb';
import { MarketDataAppProvider } from '../core/market/marketDataProvider';
import { isAndroidNativeRuntime, nativeSecret, nativeSecretKeyForProvider, nativeSecretPlaceholder } from '../platform/nativeRuntime';
import AndroidEmailSyncCard from '../components/AndroidEmailSyncCard';
import AppUpdateCard from '../components/AppUpdateCard';
import PlatformSettingsSection from '../components/PlatformSettingsSection';
import AutomationSettingsSection from '../components/AutomationSettingsSection';
import { useAppShell } from '../app/AppShell';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';

export default function SettingsPage() {
  const isAndroid = isAndroidNativeRuntime();
  const { activePlatform, enabledPlatforms } = useAppShell();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [candlestickColorScheme, setCandlestickColorScheme] = useState('red_up');
  const [themePreference, setThemePreference] = useState<'system' | 'light' | 'dark'>('system');
  const [autoSyncAfterImport, setAutoSyncAfterImport] = useState(isAndroid);
  const [autoSyncAfterTransaction, setAutoSyncAfterTransaction] = useState(isAndroid);
  const [autoSyncDailyClose, setAutoSyncDailyClose] = useState(isAndroid);
  const [marketdataEnabled, setMarketdataEnabled] = useState(false);
  const [marketdataKey, setMarketdataKey] = useState('');
  const [hasMarketdataSecret, setHasMarketdataSecret] = useState(false);
  const [connectionState, setConnectionState] = useState<'idle' | 'pending' | 'success' | 'failed'>('idle');
  const [storageUsage, setStorageUsage] = useState({ usage: 0, quota: 0 });
  const [isPersisted, setIsPersisted] = useState(false);

  useEffect(() => {
    void (async () => {
      const [scheme, theme, afterImport, afterTransaction, dailyClose, marketdata] = await Promise.all([
        db.appSettings.get('candlestick_color_scheme'), db.appSettings.get('theme_preference'),
        db.appSettings.get('auto_sync_after_import'), db.appSettings.get('auto_sync_after_transaction'), db.appSettings.get('auto_sync_daily_close'),
        db.marketProviderConfigs.get('marketdata'),
      ]);
      if (scheme && ['red_up', 'green_up'].includes(scheme.value)) setCandlestickColorScheme(scheme.value);
      if (theme && ['system', 'light', 'dark'].includes(theme.value)) setThemePreference(theme.value);
      setAutoSyncAfterImport(Boolean(afterImport?.value ?? isAndroid));
      setAutoSyncAfterTransaction(Boolean(afterTransaction?.value ?? isAndroid));
      setAutoSyncDailyClose(Boolean(dailyClose?.value ?? isAndroid));
      setMarketdataEnabled(marketdata?.enabled === 1);
      if (!isAndroid) setMarketdataKey(marketdata?.apiKey || '');
      if (isAndroid) setHasMarketdataSecret((await nativeSecret.has({ key: nativeSecretKeyForProvider('marketdata') })).exists);
    })();
    void navigator.storage?.estimate?.().then(value => setStorageUsage({ usage: value.usage || 0, quota: value.quota || 0 }));
    void navigator.storage?.persisted?.().then(setIsPersisted);
  }, [isAndroid]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const now = Date.now();
    let apiKey = marketdataKey.trim();
    if (isAndroid) {
      const existing = await db.marketProviderConfigs.get('marketdata');
      if (apiKey) {
        await nativeSecret.set({ key: nativeSecretKeyForProvider('marketdata'), value: apiKey });
        apiKey = nativeSecretPlaceholder('marketdata');
        setHasMarketdataSecret(true);
      } else apiKey = existing?.apiKey === nativeSecretPlaceholder('marketdata') ? existing.apiKey : '';
    }
    await Promise.all([
      db.appSettings.put({ key: 'candlestick_color_scheme', value: candlestickColorScheme, updatedAt: now }),
      db.appSettings.put({ key: 'theme_preference', value: themePreference, updatedAt: now }),
      db.appSettings.put({ key: 'auto_sync_after_import', value: autoSyncAfterImport, updatedAt: now }),
      db.appSettings.put({ key: 'auto_sync_after_transaction', value: autoSyncAfterTransaction, updatedAt: now }),
      db.appSettings.put({ key: 'auto_sync_daily_close', value: autoSyncDailyClose, updatedAt: now }),
      db.marketProviderConfigs.put({ provider: 'stock-sdk', enabled: 1, priority: 0, apiKey: '', baseUrl: 'stock-sdk', optionsJson: '{"keyless":true,"stockOnly":true}', createdAt: now, updatedAt: now }),
      db.marketProviderConfigs.put({ provider: 'marketdata', enabled: !isAndroid && marketdataEnabled ? 1 : 0, priority: 2, apiKey, baseUrl: 'https://api.marketdata.app/v1', optionsJson: '{"optionOnly":true}', createdAt: now, updatedAt: now }),
    ]);
    alert(isAndroid ? '设置已保存；MarketData.app 密钥仅存入 Android Keystore。' : '设置已保存到本地。');
  };

  const testMarketdata = async () => {
    const key = marketdataKey.trim() || (isAndroid && hasMarketdataSecret ? nativeSecretPlaceholder('marketdata') : '');
    if (!key) return alert('请先输入 MarketData.app Token。');
    setConnectionState('pending');
    try { setConnectionState((await new MarketDataAppProvider().testConnection(key)).ok ? 'success' : 'failed'); }
    catch { setConnectionState('failed'); }
  };

  const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

  return <div className="page page-secondary">
    <SecondaryPageHeader title="设置" fallback="/" />
    <section className="settings-group settings-global-group">
      <div className="settings-group-heading"><h2>通用偏好</h2><p>影响所有账本、平台和页面的展示方式。</p></div>
      <div className="glass-card settings-preference-list">
        <label className="settings-preference-row"><span className="settings-preference-label">涨跌颜色</span><select value={candlestickColorScheme} onChange={e => setCandlestickColorScheme(e.target.value)}><option value="red_up">红涨绿跌</option><option value="green_up">绿涨红跌</option></select></label>
        <label className="settings-preference-row"><span className="settings-preference-label">主题色</span><select value={themePreference} onChange={e => setThemePreference(e.target.value as typeof themePreference)}><option value="system">跟随系统</option><option value="light">亮色</option><option value="dark">暗色</option></select></label>
      </div>
    </section>
    <AutomationSettingsSection />
    <PlatformSettingsSection activePlatform={activePlatform} enabledPlatforms={enabledPlatforms} />
    {isAndroid && <section className="settings-group settings-services-group"><div className="settings-group-heading"><h2>Android 服务</h2><p>应用更新和邮箱同步。</p></div><AppUpdateCard /><AndroidEmailSyncCard /></section>}
    <details className="settings-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary><span><strong>高级与诊断</strong><small>行情同步、数据源、缓存和本地存储</small></span><ChevronRight size={18} /></summary>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: 12 }}>
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><h3 style={{ margin: 0 }}>行情同步</h3>
          {[["备份导入后补齐历史行情", autoSyncAfterImport, setAutoSyncAfterImport], ["交易录入后补齐历史行情", autoSyncAfterTransaction, setAutoSyncAfterTransaction], ["更新前一交易日收盘数据", autoSyncDailyClose, setAutoSyncDailyClose]].map(([label, checked, setter]) => <label key={label as string} className="flex-between"><span>{label as string}</span><input type="checkbox" checked={checked as boolean} onChange={e => (setter as (value: boolean) => void)(e.target.checked)} /></label>)}
        </div>
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><h3 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}><Key size={16} />行情数据源</h3>
          <p className="text-xs text-muted">股票（A／港／美快照及未复权日 K）固定使用 stock-sdk，无需 API Key。请求失败会保留有效缓存并在行情请求状态中显示可重试失败，不回退到其他股票源。</p>
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12 }}><strong>stock-sdk</strong><span className="badge success" style={{ marginLeft: 8 }}>股票默认源</span><p className="text-xs text-muted">Android 经 NativeMarket 请求；PWA 使用浏览器请求并受 CORS 限制。</p></div>
          {!isAndroid && <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12 }}><div className="flex-between"><strong>MarketData.app</strong><label><input type="checkbox" checked={marketdataEnabled} onChange={e => setMarketdataEnabled(e.target.checked)} /> 用于美股个股期权</label></div><div style={{ display: 'flex', gap: 8, marginTop: 8 }}><input type="password" value={marketdataKey} placeholder="MarketData.app Token" onChange={e => setMarketdataKey(e.target.value)} /><button type="button" onClick={testMarketdata}>{connectionState === 'pending' ? '测试中…' : '测试'}</button></div>{connectionState !== 'idle' && <small className={connectionState === 'success' ? 'text-success' : 'text-muted'}>{connectionState === 'success' ? '连接成功' : connectionState === 'failed' ? '连接失败' : ''}</small>}</div>}
          {isAndroid && <p className="text-xs text-muted">Android 的美股个股期权使用 Yahoo（含 chart 元数据回退）；MarketData.app 不参与 Android 期权路由。</p>}
        </div>
        <button type="submit" className="primary" style={{ alignSelf: 'flex-start' }}><Check size={16} /> 保存设置</button>
      </form>
    </details>
    <details className="settings-advanced settings-advanced-extra"><summary><span><strong>存储与缓存</strong><small>本地存储保护与应用诊断</small></span><ChevronRight size={18} /></summary><div className="glass-card"><h3><Database size={16} /> 本地存储</h3><p>已用空间：{formatBytes(storageUsage.usage)} / 预估配额：{formatBytes(storageUsage.quota)}</p><p>{isPersisted ? '本地存储已受系统保护。' : '本地存储未受持久化保护。'}</p>{!isPersisted && <button type="button" onClick={() => void navigator.storage?.persist?.().then(setIsPersisted)}><ShieldAlert size={14} /> 申请存储保护</button>}</div></details>
  </div>;
}
