import React, { useState, useEffect } from 'react';
import { Key, Database, ShieldAlert, CheckCircle2, AlertCircle, RefreshCw, Activity, Trash2, ListFilter, X, ChevronRight, ArrowUp, ArrowDown, Check } from 'lucide-react';
import { db } from '../db/localDb';
import { useLiveQuery } from 'dexie-react-hooks';
import { ItickProvider } from '../core/market/itickProvider';
import { TwelvedataProvider } from '../core/market/twelvedataProvider';
import { MarketDataAppProvider } from '../core/market/marketDataProvider';
import {
  isAndroidNativeRuntime,
  nativeSecret,
  nativeSecretKeyForProvider,
  nativeSecretPlaceholder,
} from '../platform/nativeRuntime';
import AndroidEmailSyncCard from '../components/AndroidEmailSyncCard';
import AppUpdateCard from '../components/AppUpdateCard';
import PlatformSettingsSection from '../components/PlatformSettingsSection';
import { useAppShell } from '../app/AppShell';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';

type ProviderName = 'itick' | 'twelvedata' | 'marketdata';

export default function SettingsPage() {
  const isAndroid = isAndroidNativeRuntime();
  const { activePlatform, enabledPlatforms } = useAppShell();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [candlestickColorScheme, setCandlestickColorScheme] = useState('red_up');
  const [themePreference, setThemePreference] = useState<'system' | 'light' | 'dark'>('system');
  const [activePicker, setActivePicker] = useState<'market' | 'theme' | null>(null);
  const [autoSyncAfterImport, setAutoSyncAfterImport] = useState(isAndroidNativeRuntime());
  const [autoSyncAfterTransaction, setAutoSyncAfterTransaction] = useState(isAndroidNativeRuntime());
  const [autoSyncDailyClose, setAutoSyncDailyClose] = useState(isAndroidNativeRuntime());

  // Market Providers States
  const [itickEnabled, setItickEnabled] = useState(false);
  const [itickKey, setItickKey] = useState('');
  const [itickPriority, setItickPriority] = useState(1);

  const [twelveEnabled, setTwelveEnabled] = useState(false);
  const [twelveKey, setTwelveKey] = useState('');
  const [twelvePriority, setTwelvePriority] = useState(2);

  const [marketdataEnabled, setMarketdataEnabled] = useState(false);
  const [marketdataKey, setMarketdataKey] = useState('');
  const [marketdataPriority, setMarketdataPriority] = useState(3);
  const [androidSecretPresence, setAndroidSecretPresence] = useState<Record<ProviderName, boolean>>({
    itick: false,
    twelvedata: false,
    marketdata: false,
  });
  const keyForTest = (provider: ProviderName, input: string) =>
    input || (isAndroid && androidSecretPresence[provider] ? nativeSecretPlaceholder(provider) : '');

  // Test Connection States
  const [testStatus, setTestStatus] = useState<Record<string, 'PENDING' | 'SUCCESS' | 'FAILED' | null>>({
    itick: null,
    twelvedata: null,
    marketdata: null
  });

  // Storage Stats
  const [storageUsage, setStorageUsage] = useState({ usage: 0, quota: 0, percentage: 0 });
  const [isPersisted, setIsPersisted] = useState(false);

  // Log View State
  const [logViewProvider, setLogViewProvider] = useState<string | null>(null);
  // Kept false until the diagnostic UI is deleted in the next cleanup pass;
  // source configuration remains available but operational telemetry is hidden.
  const showDiagnostics = false;

  useEffect(() => {
    // Load local settings from Dexie
    const loadSettings = async () => {
      const csSetting = await db.appSettings.get('candlestick_color_scheme');
      if (csSetting && ['red_up', 'green_up'].includes(csSetting.value)) {
        setCandlestickColorScheme(csSetting.value);
      }
      const themeSetting = await db.appSettings.get('theme_preference');
      if (themeSetting && ['system', 'light', 'dark'].includes(themeSetting.value)) {
        setThemePreference(themeSetting.value as 'system' | 'light' | 'dark');
      }
      const [afterImport, afterTransaction, dailyClose] = await Promise.all([
        db.appSettings.get('auto_sync_after_import'),
        db.appSettings.get('auto_sync_after_transaction'),
        db.appSettings.get('auto_sync_daily_close'),
      ]);
      setAutoSyncAfterImport(Boolean(afterImport?.value ?? isAndroid));
      setAutoSyncAfterTransaction(Boolean(afterTransaction?.value ?? isAndroid));
      setAutoSyncDailyClose(Boolean(dailyClose?.value ?? isAndroid));

      // 3. Providers
      const itick = await db.marketProviderConfigs.get('itick');
      if (itick) {
        setItickEnabled(itick.enabled === 1);
        setItickKey(isAndroid ? '' : itick.apiKey || '');
        setItickPriority(itick.priority);
      } else {
        setItickKey('');
      }

      const twelve = await db.marketProviderConfigs.get('twelvedata');
      if (twelve) {
        setTwelveEnabled(twelve.enabled === 1);
        setTwelveKey(isAndroid ? '' : twelve.apiKey || '');
        setTwelvePriority(twelve.priority);
      } else {
        setTwelveKey('');
      }

      const marketdata = await db.marketProviderConfigs.get('marketdata');
      if (marketdata) {
        setMarketdataEnabled(marketdata.enabled === 1);
        setMarketdataKey(isAndroid ? '' : marketdata.apiKey || '');
        setMarketdataPriority(marketdata.priority);
      } else {
        setMarketdataKey('');
      }
      if (isAndroid) {
        const presence = await Promise.all((['itick', 'twelvedata', 'marketdata'] as ProviderName[]).map(async (provider) => [
          provider,
          (await nativeSecret.has({ key: nativeSecretKeyForProvider(provider) })).exists,
        ] as const));
        setAndroidSecretPresence(Object.fromEntries(presence) as Record<ProviderName, boolean>);
      }
    };

    loadSettings();

    // Read storage info if available
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((estimate) => {
        const usage = estimate.usage || 0;
        const quota = estimate.quota || 1;
        const percentage = Math.round((usage / quota) * 10000) / 100;
        setStorageUsage({ usage, quota, percentage });
      });
    }

    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then((persisted) => {
        setIsPersisted(persisted);
      });
    }
  }, [isAndroid]);

  // Diagnostics query
  const diagnostics = useLiveQuery(async () => {
    const logs = await db.marketRequestLogs.toArray();
    const quotas = await db.marketProviderQuotaStates.toArray();
    const todayStart = new Date().setHours(0,0,0,0);

    const getProviderStats = (providerName: string) => {
      const pLogs = logs.filter(l => l.providerId === providerName);
      const quota = quotas.find(q => q.providerId === providerName);
      
      const todayLogs = pLogs.filter(l => l.createdAt >= todayStart);
      const todayRequests = todayLogs.filter(l => l.type !== 'request_start').length;
      const cacheHits = pLogs.filter(l => l.type === 'request_success' && l.detail?.status === 'cache_hit').length;

      const sortedLogs = [...pLogs].sort((a, b) => b.createdAt - a.createdAt);
      const lastRequest = sortedLogs[0] || null;

      const lastSuccessLog = pLogs.filter(l => l.type === 'request_success').sort((a, b) => b.createdAt - a.createdAt)[0];
      const lastSuccessTime = lastSuccessLog ? lastSuccessLog.createdAt : null;

      const lastErrorLog = pLogs.filter(l => l.type === 'request_failed' || l.type === 'rate_limited').sort((a, b) => b.createdAt - a.createdAt)[0];
      const lastError = lastErrorLog 
        ? `${lastErrorLog.message} (${lastErrorLog.detail?.errorCode || lastErrorLog.detail?.status || 'ERROR'})` 
        : null;

      const nextRetryAt = quota?.cooldownUntil || 0;

      let lastStatus = 'idle';
      if (lastRequest) {
        if (lastRequest.type === 'request_start') {
          lastStatus = 'pending';
        } else if (lastRequest.type === 'request_success') {
          lastStatus = lastRequest.detail?.status || 'success';
        } else if (lastRequest.type === 'rate_limited') {
          lastStatus = 'rate_limited';
        } else if (lastRequest.type === 'request_failed') {
          lastStatus = lastRequest.detail?.status || 'failed';
        }
      }

      return {
        todayRequests,
        cacheHits,
        lastStatus,
        lastRequestTime: lastRequest ? lastRequest.createdAt : null,
        lastError,
        lastSuccessTime,
        nextRetryAt
      };
    };

    return {
      itick: getProviderStats('itick'),
      twelvedata: getProviderStats('twelvedata'),
      marketdata: getProviderStats('marketdata')
    };
  }) ?? {
    itick: { todayRequests: 0, cacheHits: 0, lastStatus: 'idle', lastRequestTime: null, lastError: null, lastSuccessTime: null, nextRetryAt: 0 },
    twelvedata: { todayRequests: 0, cacheHits: 0, lastStatus: 'idle', lastRequestTime: null, lastError: null, lastSuccessTime: null, nextRetryAt: 0 },
    marketdata: { todayRequests: 0, cacheHits: 0, lastStatus: 'idle', lastRequestTime: null, lastError: null, lastSuccessTime: null, nextRetryAt: 0 }
  };

  // Log View items query
  const viewLogsList = useLiveQuery(async () => {
    if (!logViewProvider) return [];
    return db.marketRequestLogs
      .where('providerId')
      .equals(logViewProvider)
      .reverse()
      .limit(30)
      .toArray();
  }, [logViewProvider]) ?? [];

  const handleClearErrors = async (provider: string) => {
    await db.marketRequestLogs
      .where('providerId')
      .equals(provider)
      .filter(l => ['request_failed', 'rate_limited'].includes(l.type))
      .delete();
    await db.marketProviderQuotaStates.delete(provider);
    alert(`已清除 ${provider} 行情通道的历史错误请求状态记录与重试冷却状态。`);
  };

  const requestPersistence = () => {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((granted) => {
        setIsPersisted(granted);
        alert(granted ? '已成功申请本地存储持久化保护！' : '持久化保护申请被拒绝，请确认浏览器权限。');
      });
    }
  };

  const handleTestConnection = async (provider: 'itick' | 'twelvedata' | 'marketdata', key: string) => {
    if (!key.trim()) {
      alert('请输入或提供秘钥以进行连接测试！');
      return;
    }

    setTestStatus(prev => ({ ...prev, [provider]: 'PENDING' }));

    let success = false;
    try {
      if (provider === 'itick') {
        const tester = new ItickProvider();
        const result = await tester.testConnection(key);
        success = result.ok;
      } else if (provider === 'twelvedata') {
        const tester = new TwelvedataProvider();
        const result = await tester.testConnection(key);
        success = result.ok;
      } else if (provider === 'marketdata') {
        const tester = new MarketDataAppProvider();
        const result = await tester.testConnection(key);
        success = result.ok;
      }
    } catch (e) {
      console.error(`Connection test to ${provider} failed with exception:`, e);
    }

    setTestStatus(prev => ({ ...prev, [provider]: success ? 'SUCCESS' : 'FAILED' }));
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const resolveApiKey = async (provider: ProviderName, input: string): Promise<string> => {
        if (!isAndroid) return input.trim();
        const existing = await db.marketProviderConfigs.get(provider);
        const secureKey = nativeSecretKeyForProvider(provider);
        if (input.trim()) {
          await nativeSecret.set({ key: secureKey, value: input.trim() });
          return nativeSecretPlaceholder(provider);
        }
        // A previous Android build may have kept a key in IndexedDB. Migrate it
        // when saving any settings without returning it to the WebView/UI.
        if (existing?.apiKey && existing.apiKey !== nativeSecretPlaceholder(provider)) {
          await nativeSecret.set({ key: secureKey, value: existing.apiKey });
          return nativeSecretPlaceholder(provider);
        }
        return existing?.apiKey === nativeSecretPlaceholder(provider) ? existing.apiKey : '';
      };
      const [storedItickKey, storedTwelveKey, storedMarketdataKey] = await Promise.all([
        resolveApiKey('itick', itickKey),
        resolveApiKey('twelvedata', twelveKey),
        resolveApiKey('marketdata', marketdataKey),
      ]);
      await Promise.all([
        db.appSettings.put({ key: 'auto_sync_after_import', value: autoSyncAfterImport, updatedAt: Date.now() }),
        db.appSettings.put({ key: 'auto_sync_after_transaction', value: autoSyncAfterTransaction, updatedAt: Date.now() }),
        db.appSettings.put({ key: 'auto_sync_daily_close', value: autoSyncDailyClose, updatedAt: Date.now() }),
      ]);

      // 3. Save iTick Config
      await db.marketProviderConfigs.put({
        provider: 'itick',
        enabled: itickEnabled ? 1 : 0,
        apiKey: storedItickKey,
        priority: itickPriority,
        baseUrl: 'https://api.itick.org',
        optionsJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      // 3. Save TwelveData Config
      await db.marketProviderConfigs.put({
        provider: 'twelvedata',
        enabled: twelveEnabled ? 1 : 0,
        apiKey: storedTwelveKey,
        priority: twelvePriority,
        baseUrl: 'https://api.twelvedata.com',
        optionsJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      // 4. Save MarketData Config
      await db.marketProviderConfigs.put({
        provider: 'marketdata',
        enabled: marketdataEnabled ? 1 : 0,
        apiKey: storedMarketdataKey,
        priority: marketdataPriority,
        baseUrl: 'https://api.marketdata.app/v1',
        optionsJson: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      if (isAndroid) {
        setAndroidSecretPresence({
          itick: Boolean(storedItickKey),
          twelvedata: Boolean(storedTwelveKey),
          marketdata: Boolean(storedMarketdataKey),
        });
      }
      alert(isAndroid ? '配置已保存；第三方行情密钥已加密保存到 Android Keystore。' : '所有配置与秘钥参数已成功保存至本地 IndexedDB！');
    } catch (e) {
      console.error('Failed to save settings:', e);
      alert('保存设置失败，请检查控制台错误日志。');
    }
  };

  const updatePreference = async (key: 'candlestick_color_scheme' | 'theme_preference', value: string) => {
    await db.appSettings.put({ key, value, updatedAt: Date.now() });
    if (key === 'candlestick_color_scheme') setCandlestickColorScheme(value);
    else if (['system', 'light', 'dark'].includes(value)) setThemePreference(value as 'system' | 'light' | 'dark');
    setActivePicker(null);
  };

  useEffect(() => {
    if (!activePicker) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setActivePicker(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activePicker]);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'success':
        return <span className="badge success">成功</span>;
      case 'pending':
        return <span className="badge info spin">请求中</span>;
      case 'rate_limited':
        return <span className="badge warning">额度受限</span>;
      case 'timeout':
        return <span className="badge danger">超时</span>;
      case 'network_error':
      case 'cors_error':
        return <span className="badge danger">网络/跨域错误</span>;
      case 'provider_unconfigured':
        return <span className="badge secondary">未配置</span>;
      case 'idle':
        return <span className="badge secondary">闲置</span>;
      default:
        return <span className="badge secondary">{status}</span>;
    }
  };

  return (
    <div className="page page-secondary">
      {/* Header */}
      <SecondaryPageHeader title="设置" fallback="/" />

      <section className="settings-group settings-global-group">
        <div className="settings-group-heading"><h2>通用偏好</h2><p>影响所有账本、平台和页面的展示方式。</p></div>
        <div className="glass-card settings-global-card settings-preference-list">
          <button type="button" className="settings-preference-row" onClick={() => setActivePicker('market')}>
            <span className="settings-preference-label">涨跌颜色</span>
            <span className="settings-preference-value">
              <span className="market-scheme-icon" aria-hidden="true"><ArrowUp size={18} /><ArrowDown size={18} /></span>
              <span>{candlestickColorScheme === 'green_up' ? '绿涨红跌' : '红涨绿跌'}</span>
              <ChevronRight size={18} aria-hidden="true" />
            </span>
          </button>
          <button type="button" className="settings-preference-row" onClick={() => setActivePicker('theme')}>
            <span className="settings-preference-label">主题色</span>
            <span className="settings-preference-value"><span>{themePreference === 'light' ? '亮色' : themePreference === 'dark' ? '暗色' : '跟随系统'}</span><ChevronRight size={18} aria-hidden="true" /></span>
          </button>
        </div>
      </section>

      {activePicker && <div className="action-sheet-backdrop" onClick={() => setActivePicker(null)}>
        <div className="action-sheet settings-preference-sheet" role="dialog" aria-modal="true" aria-label={activePicker === 'market' ? '选择涨跌颜色' : '选择主题色'} onClick={(event) => event.stopPropagation()}>
          <div className="settings-preference-sheet-header"><h2>{activePicker === 'market' ? '涨跌颜色' : '主题色'}</h2><button type="button" className="icon-button" onClick={() => setActivePicker(null)} aria-label="关闭"><X size={18} /></button></div>
          <div className="surface-list">
            {(activePicker === 'market' ? [
              { value: 'red_up', label: '红涨绿跌', hint: 'A 股 / 港股常用' },
              { value: 'green_up', label: '绿涨红跌', hint: '美股常用' },
            ] : [
              { value: 'system', label: '跟随系统', hint: '自动匹配设备外观' },
              { value: 'light', label: '亮色', hint: '始终使用亮色界面' },
              { value: 'dark', label: '暗色', hint: '始终使用暗色界面' },
            ]).map((option) => {
              const selected = activePicker === 'market' ? candlestickColorScheme === option.value : themePreference === option.value;
              return <button type="button" key={option.value} className={`list-row settings-preference-option${selected ? ' selected' : ''}`} onClick={() => void updatePreference(activePicker === 'market' ? 'candlestick_color_scheme' : 'theme_preference', option.value)}>
                {activePicker === 'market' && <span className={`market-scheme-icon ${option.value === 'green_up' ? 'green-up' : 'red-up'}`} aria-hidden="true"><ArrowUp size={18} /><ArrowDown size={18} /></span>}
                <span className="list-row-main"><span className="list-row-title">{option.label}</span><small>{option.hint}</small></span>
                {selected && <Check size={18} aria-label="已选择" />}
              </button>;
            })}
          </div>
        </div>
      </div>}
      <PlatformSettingsSection activePlatform={activePlatform} enabledPlatforms={enabledPlatforms} />
      {isAndroid && <section className="settings-group settings-services-group">
        <div className="settings-group-heading"><h2>Android 服务</h2><p>仅 Android 提供应用更新和邮箱同步能力。</p></div>
        <AppUpdateCard />
        <AndroidEmailSyncCard />
      </section>}

      <details className="settings-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary><span><strong>高级与诊断</strong><small>行情同步、数据源、缓存和本地存储</small></span><ChevronRight size={18} /></summary>
      <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '12px' }}>
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>行情同步</h3>
          <p className="text-xs text-muted" style={{ margin: 0 }}>仅在应用打开后检查。实时价格始终需要在持仓页手动刷新。</p>
          {[
            ['备份导入后补齐历史行情', autoSyncAfterImport, setAutoSyncAfterImport],
            ['交易录入后补齐历史行情', autoSyncAfterTransaction, setAutoSyncAfterTransaction],
            ['更新前一交易日收盘数据', autoSyncDailyClose, setAutoSyncDailyClose],
          ].map(([label, checked, setChecked]) => <label key={label as string} className="flex-between" style={{ gap: 12, fontSize: 14 }}><span>{label as string}</span><input type="checkbox" checked={checked as boolean} onChange={(event) => (setChecked as (value: boolean) => void)(event.target.checked)} style={{ width: 20, height: 20 }} /></label>)}
        </div>

        {/* Market Data Config */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Key size={16} />
            行情 API 与直连优先级配置
          </h3>
          
          <p className="text-xs text-muted">
            本软件为本地优先的直连行情应用。浏览器会将自填密钥保存在本机站点数据中；Android 使用系统 Keystore。未配置任何第三方密钥时，Web 仅使用可直连的缓存与行情通道。
          </p>

          {/* iTick */}
          <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
            <div className="flex-between" style={{ marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>iTick API (支持美/港/A股)</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem', cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={itickEnabled} 
                  onChange={(e) => setItickEnabled(e.target.checked)} 
                />
                启用此通道
              </label>
            </div>
            
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <div style={{ flex: 1 }}>
                <input 
                  type="password" 
                  placeholder={isAndroid && androidSecretPresence.itick ? '已安全保存；留空不变更' : '请输入 iTick Token'} 
                  value={itickKey} 
                  onChange={(e) => setItickKey(e.target.value)} 
                />
              </div>
              <div style={{ width: '80px' }}>
                <select value={itickPriority} onChange={(e) => setItickPriority(parseInt(e.target.value))}>
                  <option value={1}>优先级 1</option>
                  <option value={2}>优先级 2</option>
                  <option value={3}>优先级 3</option>
                </select>
              </div>
              <button 
                type="button" 
                onClick={() => handleTestConnection('itick', keyForTest('itick', itickKey))} 
                style={{ padding: '0 0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}
              >
                {testStatus.itick === 'PENDING' ? <RefreshCw size={12} className="spin" /> : null}
                测试
              </button>
            </div>

            {testStatus.itick && (
              <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', color: testStatus.itick === 'SUCCESS' ? 'var(--color-success)' : 'var(--color-error)' }}>
                {testStatus.itick === 'SUCCESS' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {testStatus.itick === 'SUCCESS' ? '连接成功！API 鉴权通过。' : '连接失败：请检查 Token 是否有效或网络 CORS 是否受限。'}
              </div>
            )}
          </div>

          {/* TwelveData */}
          <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
            <div className="flex-between" style={{ marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>Twelve Data API (支持美/港/A股)</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem', cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={twelveEnabled} 
                  onChange={(e) => setTwelveEnabled(e.target.checked)} 
                />
                启用此通道
              </label>
            </div>
            
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <div style={{ flex: 1 }}>
                <input 
                  type="password" 
                  placeholder={isAndroid && androidSecretPresence.twelvedata ? '已安全保存；留空不变更' : '请输入 Twelve Data API Key'} 
                  value={twelveKey} 
                  onChange={(e) => setTwelveKey(e.target.value)} 
                />
              </div>
              <div style={{ width: '80px' }}>
                <select value={twelvePriority} onChange={(e) => setTwelvePriority(parseInt(e.target.value))}>
                  <option value={1}>优先级 1</option>
                  <option value={2}>优先级 2</option>
                  <option value={3}>优先级 3</option>
                </select>
              </div>
              <button 
                type="button" 
                onClick={() => handleTestConnection('twelvedata', keyForTest('twelvedata', twelveKey))} 
                style={{ padding: '0 0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}
              >
                {testStatus.twelvedata === 'PENDING' ? <RefreshCw size={12} className="spin" /> : null}
                测试
              </button>
            </div>

            {testStatus.twelvedata && (
              <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', color: testStatus.twelvedata === 'SUCCESS' ? 'var(--color-success)' : 'var(--color-error)' }}>
                {testStatus.twelvedata === 'SUCCESS' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {testStatus.twelvedata === 'SUCCESS' ? '连接成功！API 鉴权通过。' : '连接失败：请检查 API Key 是否有效。'}
              </div>
            )}
          </div>

          {/* MarketData.app */}
          <div>
            <div className="flex-between" style={{ marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>MarketData.app API (支持美股股票/期权)</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem', cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={marketdataEnabled} 
                  onChange={(e) => setMarketdataEnabled(e.target.checked)} 
                />
                启用此通道
              </label>
            </div>
            
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <div style={{ flex: 1 }}>
                <input 
                  type="password" 
                  placeholder={isAndroid && androidSecretPresence.marketdata ? '已安全保存；留空不变更' : '请输入 MarketData.app Token'} 
                  value={marketdataKey} 
                  onChange={(e) => setMarketdataKey(e.target.value)} 
                />
              </div>
              <div style={{ width: '80px' }}>
                <select value={marketdataPriority} onChange={(e) => setMarketdataPriority(parseInt(e.target.value))}>
                  <option value={1}>优先级 1</option>
                  <option value={2}>优先级 2</option>
                  <option value={3}>优先级 3</option>
                </select>
              </div>
              <button 
                type="button" 
                onClick={() => handleTestConnection('marketdata', keyForTest('marketdata', marketdataKey))} 
                style={{ padding: '0 0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem' }}
              >
                {testStatus.marketdata === 'PENDING' ? <RefreshCw size={12} className="spin" /> : null}
                测试
              </button>
            </div>

            {testStatus.marketdata && (
              <div style={{ marginTop: '0.35rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem', color: testStatus.marketdata === 'SUCCESS' ? 'var(--color-success)' : 'var(--color-error)' }}>
                {testStatus.marketdata === 'SUCCESS' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                {testStatus.marketdata === 'SUCCESS' ? '连接成功！API 鉴权通过。' : '连接失败：请检查 Token 是否有效或网络是否支持 CORS。'}
              </div>
            )}
          </div>

          <button type="submit" className="primary" style={{ alignSelf: 'flex-start', padding: '0.5rem 1.25rem', marginTop: '0.5rem' }}>
            保存配置参数
          </button>
        </div>
      </form>
      </details>

      {/* Diagnostics intentionally removed from the product UI; data source setup remains above. */}
      {showDiagnostics && <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Activity size={16} style={{ color: 'var(--accent)' }} />
          行情数据源诊断与可观测面板
        </h3>
        <p className="text-xs text-muted" style={{ marginTop: '-0.25rem' }}>
          监控直连行情通道的健康状态、请求限制与缓存统计。
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* iTick Diagnostics */}
          <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="flex-between">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>iTick</span>
                {itickEnabled ? <span className="badge success">已启用</span> : <span className="badge secondary">未启用</span>}
              </div>
              <span className="text-xs text-muted">优先级 {itickPriority}</span>
            </div>

            <div className="text-xs" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.25rem' }}>
              <div>秘钥配置: <span style={{ fontWeight: 600 }}>{itickKey || androidSecretPresence.itick ? '✅ 已配置' : '❌ 未配置'}</span></div>
              <div>当前状态: {getStatusBadge(diagnostics.itick.lastStatus)}</div>
              <div>今日请求: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{diagnostics.itick.todayRequests} 次</span></div>
              <div>缓存命中: <span style={{ fontWeight: 600, color: 'var(--color-success)' }}>{diagnostics.itick.cacheHits} 次</span></div>
              <div style={{ gridColumn: 'span 2' }}>
                最近成功: <span style={{ fontWeight: 500 }}>{diagnostics.itick.lastSuccessTime ? new Date(diagnostics.itick.lastSuccessTime ?? Date.now()).toLocaleString('zh-CN') : '无成功记录'}</span>
              </div>
              {diagnostics.itick.nextRetryAt > Date.now() && (
                <div style={{ gridColumn: 'span 2', color: 'var(--color-warning)' }}>
                  限流恢复: 建议在 <span style={{ fontWeight: 600 }}>{new Date(diagnostics.itick.nextRetryAt).toLocaleTimeString()}</span> 后重试（约 {Math.round((diagnostics.itick.nextRetryAt - Date.now()) / 1000)} 秒后）
                </div>
              )}
              {diagnostics.itick.lastError && (
                <div style={{ gridColumn: 'span 2', color: 'var(--color-error)', padding: '0.35rem', backgroundColor: 'rgba(239, 68, 68, 0.05)', borderRadius: '4px', border: '1px dashed rgba(239, 68, 68, 0.15)' }}>
                  最近异常: {diagnostics.itick.lastError}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <button type="button" className="text-xs" onClick={() => handleTestConnection('itick', keyForTest('itick', itickKey))} style={{ padding: '0.25rem 0.5rem' }}>
                测试连接
              </button>
              <button type="button" className="text-xs" onClick={() => setLogViewProvider('itick')} style={{ padding: '0.25rem 0.5rem' }}>
                查看最近日志
              </button>
              <button type="button" className="text-xs" onClick={() => handleClearErrors('itick')} style={{ padding: '0.25rem 0.5rem', display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
                <Trash2 size={10} /> 清除错误状态
              </button>
            </div>
          </div>

          {/* TwelveData Diagnostics */}
          <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="flex-between">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Twelve Data</span>
                {twelveEnabled ? <span className="badge success">已启用</span> : <span className="badge secondary">未启用</span>}
              </div>
              <span className="text-xs text-muted">优先级 {twelvePriority}</span>
            </div>

            <div className="text-xs" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.25rem' }}>
              <div>秘钥配置: <span style={{ fontWeight: 600 }}>{twelveKey || androidSecretPresence.twelvedata ? '✅ 已配置' : '❌ 未配置'}</span></div>
              <div>当前状态: {getStatusBadge(diagnostics.twelvedata.lastStatus)}</div>
              <div>今日请求: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{diagnostics.twelvedata.todayRequests} 次</span></div>
              <div>缓存命中: <span style={{ fontWeight: 600, color: 'var(--color-success)' }}>{diagnostics.twelvedata.cacheHits} 次</span></div>
              <div style={{ gridColumn: 'span 2' }}>
                最近成功: <span style={{ fontWeight: 500 }}>{diagnostics.twelvedata.lastSuccessTime ? new Date(diagnostics.twelvedata.lastSuccessTime ?? Date.now()).toLocaleString('zh-CN') : '无成功记录'}</span>
              </div>
              {diagnostics.twelvedata.nextRetryAt > Date.now() && (
                <div style={{ gridColumn: 'span 2', color: 'var(--color-warning)' }}>
                  限流恢复: 建议在 <span style={{ fontWeight: 600 }}>{new Date(diagnostics.twelvedata.nextRetryAt).toLocaleTimeString()}</span> 后重试（约 {Math.round((diagnostics.twelvedata.nextRetryAt - Date.now()) / 1000)} 秒后）
                </div>
              )}
              {diagnostics.twelvedata.lastError && (
                <div style={{ gridColumn: 'span 2', color: 'var(--color-error)', padding: '0.35rem', backgroundColor: 'rgba(239, 68, 68, 0.05)', borderRadius: '4px', border: '1px dashed rgba(239, 68, 68, 0.15)' }}>
                  最近异常: {diagnostics.twelvedata.lastError}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <button type="button" className="text-xs" onClick={() => handleTestConnection('twelvedata', keyForTest('twelvedata', twelveKey))} style={{ padding: '0.25rem 0.5rem' }}>
                测试连接
              </button>
              <button type="button" className="text-xs" onClick={() => setLogViewProvider('twelvedata')} style={{ padding: '0.25rem 0.5rem' }}>
                查看最近日志
              </button>
              <button type="button" className="text-xs" onClick={() => handleClearErrors('twelvedata')} style={{ padding: '0.25rem 0.5rem', display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
                <Trash2 size={10} /> 清除错误状态
              </button>
            </div>
          </div>

          {/* MarketData.app Diagnostics */}
          <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="flex-between">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>MarketData.app</span>
                {marketdataEnabled ? <span className="badge success">已启用</span> : <span className="badge secondary">未启用</span>}
              </div>
              <span className="text-xs text-muted">优先级 {marketdataPriority}</span>
            </div>

            <div className="text-xs" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.25rem' }}>
              <div>秘钥配置: <span style={{ fontWeight: 600 }}>{marketdataKey || androidSecretPresence.marketdata ? '✅ 已配置' : '❌ 未配置'}</span></div>
              <div>当前状态: {getStatusBadge(diagnostics.marketdata.lastStatus)}</div>
              <div>今日请求: <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{diagnostics.marketdata.todayRequests} 次</span></div>
              <div>缓存命中: <span style={{ fontWeight: 600, color: 'var(--color-success)' }}>{diagnostics.marketdata.cacheHits} 次</span></div>
              <div style={{ gridColumn: 'span 2' }}>
                最近成功: <span style={{ fontWeight: 500 }}>{diagnostics.marketdata.lastSuccessTime ? new Date(diagnostics.marketdata.lastSuccessTime ?? Date.now()).toLocaleString('zh-CN') : '无成功记录'}</span>
              </div>
              {diagnostics.marketdata.nextRetryAt > Date.now() && (
                <div style={{ gridColumn: 'span 2', color: 'var(--color-warning)' }}>
                  限流恢复: 建议在 <span style={{ fontWeight: 600 }}>{new Date(diagnostics.marketdata.nextRetryAt).toLocaleTimeString()}</span> 后重试（约 {Math.round((diagnostics.marketdata.nextRetryAt - Date.now()) / 1000)} 秒后）
                </div>
              )}
              {diagnostics.marketdata.lastError && (
                <div style={{ gridColumn: 'span 2', color: 'var(--color-error)', padding: '0.35rem', backgroundColor: 'rgba(239, 68, 68, 0.05)', borderRadius: '4px', border: '1px dashed rgba(239, 68, 68, 0.15)' }}>
                  最近异常: {diagnostics.marketdata.lastError}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
              <button type="button" className="text-xs" onClick={() => handleTestConnection('marketdata', keyForTest('marketdata', marketdataKey))} style={{ padding: '0.25rem 0.5rem' }}>
                测试连接
              </button>
              <button type="button" className="text-xs" onClick={() => setLogViewProvider('marketdata')} style={{ padding: '0.25rem 0.5rem' }}>
                查看最近日志
              </button>
              <button type="button" className="text-xs" onClick={() => handleClearErrors('marketdata')} style={{ padding: '0.25rem 0.5rem', display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
                <Trash2 size={10} /> 清除错误状态
              </button>
            </div>
          </div>
        </div>
      </div>}

      <details className="settings-advanced settings-advanced-extra">
      <summary><span><strong>存储与缓存</strong><small>本地存储保护与应用诊断</small></span><ChevronRight size={18} /></summary>
      {/* Storage and PWA Section */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Database size={16} />
          本地存储与 PWA 诊断
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.50rem', fontSize: '0.85rem' }}>
          <div className="flex-between">
            <span>存储引擎:</span>
            <span style={{ fontWeight: 600 }}>Browser IndexedDB</span>
          </div>
          <div className="flex-between">
            <span>持久化存储授权:</span>
            <span style={{ 
              color: isPersisted ? 'var(--color-success)' : 'var(--color-warning)',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem'
            }}>
              {isPersisted ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
              {isPersisted ? '受系统保护 (Persisted)' : '未受保护 (Best-Effort)'}
            </span>
          </div>
          <div className="flex-between">
            <span>已用空间:</span>
            <span style={{ fontWeight: 600 }}>{formatBytes(storageUsage.usage)}</span>
          </div>
          <div className="flex-between">
            <span>预估可用配额:</span>
            <span style={{ fontWeight: 600 }}>{formatBytes(storageUsage.quota)}</span>
          </div>
          
          <div style={{ width: '100%', height: '6px', backgroundColor: 'var(--bg-input)', borderRadius: '3px', overflow: 'hidden', marginTop: '0.25rem' }}>
            <div style={{ width: `${storageUsage.percentage}%`, height: '100%', backgroundColor: 'var(--accent)' }} />
          </div>
        </div>

        {!isPersisted && (
          <button onClick={requestPersistence} style={{ marginTop: '0.25rem', fontSize: '0.8rem', padding: '0.5rem 1rem' }}>
            申请存储防删保护
          </button>
        )}
      </div>

      </details>

      {/* Log view Modal Drawer */}
      {logViewProvider && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          backgroundColor: 'rgba(0,0,0,0.5)',
          zIndex: 1000,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-end'
        }}>
          <div className="glass-card" style={{
            width: '100%',
            maxWidth: '600px',
            maxHeight: '80vh',
            borderTopLeftRadius: '16px',
            borderTopRightRadius: '16px',
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            padding: '1.25rem',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem',
            border: '1px solid var(--border-color)',
            boxShadow: '0 -4px 20px rgba(0,0,0,0.3)',
            backgroundColor: '#0f172a'
          }}>
            <div className="flex-between">
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ListFilter size={18} style={{ color: 'var(--accent)' }} />
                {logViewProvider} 行情直连最近 30 条请求日志
              </h3>
              <button 
                type="button" 
                onClick={() => setLogViewProvider(null)} 
                style={{ padding: '0.25rem', borderRadius: '50%', minWidth: 0, width: '28px', height: '28px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', flex: 1, paddingRight: '0.25rem' }}>
              {viewLogsList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  暂无日志记录
                </div>
              ) : (
                viewLogsList.map((log) => {
                  const status = log.type === 'request_start' ? 'pending' : (log.detail?.status || 'failed');
                  const logTypeLabel = log.type === 'request_start' ? '发起请求' : 
                                      log.type === 'request_success' ? '成功' : 
                                      log.type === 'rate_limited' ? '频控限流' : '请求失败';
                  return (
                    <div 
                      key={log.id} 
                      style={{ 
                        padding: '0.65rem', 
                        borderRadius: '6px', 
                        border: '1px solid var(--border-color)', 
                        backgroundColor: 'rgba(255,255,255,0.01)',
                        fontSize: '0.75rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.25rem'
                      }}
                    >
                      <div className="flex-between">
                        <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                          {logTypeLabel}
                        </span>
                        {getStatusBadge(status)}
                      </div>
                      <div className="text-muted" style={{ wordBreak: 'break-all' }}>
                        消息: {log.message}
                      </div>
                      {log.detail?.endpoint && (
                        <div className="text-muted" style={{ wordBreak: 'break-all', fontSize: '0.7rem' }}>
                          URL: {log.detail.endpoint}
                        </div>
                      )}
                      <div className="flex-between text-muted" style={{ fontSize: '0.7rem', marginTop: '0.15rem' }}>
                        <span>
                          {log.type !== 'request_start' && (
                            `耗时: ${log.detail?.durationMs ?? '-'}ms | HTTP ${log.detail?.httpStatus || '-'} ${log.detail?.errorCode ? '| 错误码: ' + log.detail.errorCode : ''}`
                          )}
                        </span>
                        <span>{new Date(log.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
