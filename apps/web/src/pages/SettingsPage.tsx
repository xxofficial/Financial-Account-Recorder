import { useEffect, useState } from 'react';
import { Check, ChevronRight, Database, Key, ShieldAlert, TrendingDown, TrendingUp } from 'lucide-react';
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
  const [autoSyncAfterImport, setAutoSyncAfterImport] = useState(true);
  const [autoSyncAfterTransaction, setAutoSyncAfterTransaction] = useState(true);
  const [autoSyncDailyClose, setAutoSyncDailyClose] = useState(true);
  const [preferenceSheet, setPreferenceSheet] = useState<'candlestick' | 'theme' | null>(null);
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
      setAutoSyncAfterImport(Boolean(afterImport?.value ?? true));
      setAutoSyncAfterTransaction(Boolean(afterTransaction?.value ?? true));
      setAutoSyncDailyClose(Boolean(dailyClose?.value ?? true));
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
      db.marketProviderConfigs.put({ provider: 'marketdata', enabled: !isAndroid && marketdataEnabled ? 1 : 0, priority: 2, apiKey, baseUrl: 'https://api.marketdata.app/v1', optionsJson: '{"historicalFallback":true}', createdAt: now, updatedAt: now }),
    ]);
    alert(isAndroid ? '设置已保存到系统安全存储。' : '设置已保存到本地。');
  };

  const testMarketdata = async () => {
    const key = marketdataKey.trim() || (isAndroid && hasMarketdataSecret ? nativeSecretPlaceholder('marketdata') : '');
    if (!key) return alert('请先输入备用服务密钥。');
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
        <button type="button" className="settings-preference-row" onClick={() => setPreferenceSheet('candlestick')}><span className="settings-preference-label">涨跌颜色</span><span className="settings-preference-value"><span className={`market-scheme-icon ${candlestickColorScheme}`} aria-hidden="true"><TrendingUp size={16} /><TrendingDown size={16} /></span>{candlestickColorScheme === 'green_up' ? '绿涨红跌' : '红涨绿跌'}<ChevronRight size={18} /></span></button>
        <button type="button" className="settings-preference-row" onClick={() => setPreferenceSheet('theme')}><span className="settings-preference-label">主题色</span><span className="settings-preference-value">{{ system: '跟随系统', light: '亮色', dark: '暗色' }[themePreference]}<ChevronRight size={18} /></span></button>
      </div>
    </section>
    <AutomationSettingsSection />
    <PlatformSettingsSection activePlatform={activePlatform} enabledPlatforms={enabledPlatforms} />
    {isAndroid && <section className="settings-group settings-services-group"><div className="settings-group-heading"><h2>Android 服务</h2><p>应用更新和邮箱同步。</p></div><AppUpdateCard /><AndroidEmailSyncCard /></section>}
    <details className="settings-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary><span><strong>行情与诊断</strong><small>行情同步、备用数据源和本地存储</small></span><ChevronRight size={18} /></summary>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: 12 }}>
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><h3 style={{ margin: 0 }}>行情同步</h3>
          {[["备份导入后补齐历史行情", autoSyncAfterImport, setAutoSyncAfterImport], ["交易录入后补齐历史行情", autoSyncAfterTransaction, setAutoSyncAfterTransaction], ["更新前一交易日收盘数据", autoSyncDailyClose, setAutoSyncDailyClose]].map(([label, checked, setter]) => <label key={label as string} className="flex-between"><span>{label as string}</span><input type="checkbox" checked={checked as boolean} onChange={e => (setter as (value: boolean) => void)(e.target.checked)} /></label>)}
        </div>
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><h3 style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center' }}><Key size={16} />行情数据源</h3>
          <p className="text-xs text-muted">应用会优先使用默认行情服务；美股历史数据无法获取时，可尝试备用服务。短暂网络问题会自动重试，不会直接判为不支持。</p>
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12 }}><strong>默认行情服务</strong><span className="badge success" style={{ marginLeft: 8 }}>股票默认源</span><p className="text-xs text-muted">无需额外密钥；网页端会根据网络环境返回可用状态。</p></div>
          {!isAndroid && <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12 }}><div className="flex-between"><strong>备用美股行情服务</strong><label><input type="checkbox" checked={marketdataEnabled} onChange={e => setMarketdataEnabled(e.target.checked)} /> 用于美股历史数据和期权</label></div><div style={{ display: 'flex', gap: 8, marginTop: 8 }}><input type="password" value={marketdataKey} placeholder="输入备用服务密钥" onChange={e => setMarketdataKey(e.target.value)} /><button type="button" onClick={testMarketdata}>{connectionState === 'pending' ? '测试中…' : '测试连接'}</button></div><small className="text-muted">密钥仅保存于本机浏览器；连接失败时会按临时问题重试。</small>{connectionState !== 'idle' && <small className={connectionState === 'success' ? 'text-success' : 'text-muted'}>{connectionState === 'success' ? '连接成功' : '连接失败，请检查密钥或稍后重试'}</small>}</div>}
          {isAndroid && <p className="text-xs text-muted">移动端会使用系统提供的美股行情服务；此处无需配置备用服务。</p>}
        </div>
        <button type="submit" className="primary" style={{ alignSelf: 'flex-start' }}><Check size={16} /> 保存设置</button>
      </form>
    </details>
    <details className="settings-advanced settings-advanced-extra"><summary><span><strong>存储与缓存</strong><small>本地存储保护与应用诊断</small></span><ChevronRight size={18} /></summary><div className="glass-card"><h3><Database size={16} /> 本地存储</h3><p>已用空间：{formatBytes(storageUsage.usage)} / 预估配额：{formatBytes(storageUsage.quota)}</p><p>{isPersisted ? '本地存储已受系统保护。' : '本地存储未受持久化保护。'}</p>{!isPersisted && <button type="button" onClick={() => void navigator.storage?.persist?.().then(setIsPersisted)}><ShieldAlert size={14} /> 申请存储保护</button>}</div></details>
    {preferenceSheet === 'candlestick' && <div className="action-sheet-backdrop" onClick={() => setPreferenceSheet(null)}><div className="action-sheet settings-preference-sheet" role="dialog" aria-modal="true" aria-label="选择涨跌颜色" onClick={event => event.stopPropagation()}><div className="settings-preference-sheet-header"><h2>涨跌颜色</h2></div><div className="surface-list">{[['red_up', '红涨绿跌', 'A 股与港股常用'] as const, ['green_up', '绿涨红跌', '美股常用'] as const].map(([value, label, description]) => <button key={value} type="button" className={`list-row settings-preference-option ${candlestickColorScheme === value ? 'selected' : ''}`} onClick={() => { setCandlestickColorScheme(value); setPreferenceSheet(null); }}><span className="list-row-main"><span className="list-row-title">{label}</span><small>{description}</small></span>{candlestickColorScheme === value && <Check size={18} />}</button>)}</div><button type="button" className="action-sheet-cancel" onClick={() => setPreferenceSheet(null)}>取消</button></div></div>}
    {preferenceSheet === 'theme' && <div className="action-sheet-backdrop" onClick={() => setPreferenceSheet(null)}><div className="action-sheet settings-preference-sheet" role="dialog" aria-modal="true" aria-label="选择主题色" onClick={event => event.stopPropagation()}><div className="settings-preference-sheet-header"><h2>主题色</h2></div><div className="surface-list">{[['system', '跟随系统', '使用设备当前主题'] as const, ['light', '亮色', '始终使用亮色界面'] as const, ['dark', '暗色', '始终使用暗色界面'] as const].map(([value, label, description]) => <button key={value} type="button" className={`list-row settings-preference-option ${themePreference === value ? 'selected' : ''}`} onClick={() => { setThemePreference(value); setPreferenceSheet(null); }}><span className="list-row-main"><span className="list-row-title">{label}</span><small>{description}</small></span>{themePreference === value && <Check size={18} />}</button>)}</div><button type="button" className="action-sheet-cancel" onClick={() => setPreferenceSheet(null)}>取消</button></div></div>}
  </div>;
}
