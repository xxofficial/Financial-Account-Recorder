import { useEffect, useState } from 'react';
import { CalendarDays, RefreshCw, Save } from 'lucide-react';
import { db } from '../db/localDb';
import { getItickCalendarStatus, ITICK_CALENDAR_TOKEN_KEY, normalizeItickToken, syncItickCalendar } from '../core/market/itickCalendarProvider';
import { CORPORATE_ACTION_AUTO_SYNC_KEY } from '../core/corporateActions/splitActionService';

export default function AutomationSettingsSection() {
  const [calendarToken, setCalendarToken] = useState('');
  const [calendarStatus, setCalendarStatus] = useState<{ configured: boolean; fetchedAt?: number; lastError?: string; recordCount: number }>({ configured: false, recordCount: 0 });
  const [calendarSyncing, setCalendarSyncing] = useState(false);
  const [corporateActionAutoSync, setCorporateActionAutoSync] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      const [calendarSetting, corporateActionSetting, status] = await Promise.all([
        db.appSettings.get(ITICK_CALENDAR_TOKEN_KEY),
        db.appSettings.get(CORPORATE_ACTION_AUTO_SYNC_KEY),
        getItickCalendarStatus(),
      ]);
      setCalendarToken(typeof calendarSetting?.value === 'string' ? calendarSetting.value : '');
      setCorporateActionAutoSync(Boolean(corporateActionSetting?.value));
      setCalendarStatus(status);
    })();
  }, []);

  const syncCalendar = async (force = false) => {
    setCalendarSyncing(true);
    try {
      const cache = await syncItickCalendar(force);
      const status = await getItickCalendarStatus();
      setCalendarStatus(status);
      return cache;
    } finally {
      setCalendarSyncing(false);
    }
  };

  const saveCalendarToken = async () => {
    const value = normalizeItickToken(calendarToken);
    if (value) await db.appSettings.put({ key: ITICK_CALENDAR_TOKEN_KEY, value, updatedAt: Date.now() });
    else await db.appSettings.delete(ITICK_CALENDAR_TOKEN_KEY);
    const cache = await syncCalendar(true);
    setMessage(cache?.lastError ? `交易日历同步未完成：${cache.lastError}` : value ? 'iTick 交易日历 Token 已保存并完成同步。' : 'iTick 交易日历 Token 已清除，将使用本地缓存或工作日降级。');
  };

  const saveCorporateActionAutoSync = async (enabled: boolean) => {
    setCorporateActionAutoSync(enabled);
    await db.appSettings.put({ key: CORPORATE_ACTION_AUTO_SYNC_KEY, value: enabled, updatedAt: Date.now() });
    setMessage(enabled ? '已开启公司行动自动检查：每次打开应用会按市场收市窗口判断是否同步一次。' : '已关闭公司行动自动检查；仍可在公司行动页手动同步。');
  };

  const calendarUpdatedAt = calendarStatus.fetchedAt ? new Date(calendarStatus.fetchedAt).toLocaleString() : '尚未同步';

  return <section className="settings-group settings-global-sync-group">
    <div className="settings-group-heading"><div><h2>自动同步</h2><p>这些设置作用于整个账本，不属于任何单一交易平台。</p></div></div>
    <div className="glass-card settings-platform-subsection settings-calendar-config">
      <h3><CalendarDays size={16} />交易日历自动同步</h3>
      <p>港股和美股通过 iTick 获取市场假期，A 股继续使用 stock-sdk。Token 只保存在本机，不会进入备份。</p>
      <label className="settings-secret-field"><span>{calendarStatus.configured ? '已配置（留空可清除）' : '尚未配置'}</span><input type="password" value={calendarToken} onChange={(event) => setCalendarToken(event.target.value)} placeholder="请输入 iTick API Token" /></label>
      <div className="settings-inline-actions"><button type="button" className="primary settings-save-button" onClick={() => void saveCalendarToken()}><Save size={15} />保存并同步</button><button type="button" className="settings-save-button" onClick={() => void syncCalendar(true)} disabled={!calendarStatus.configured || calendarSyncing}><RefreshCw size={15} className={calendarSyncing ? 'spin' : undefined} />立即刷新</button></div>
      <small>最近同步：{calendarUpdatedAt}；已缓存 {calendarStatus.recordCount} 个市场年度{calendarStatus.lastError ? `；最近一次错误：${calendarStatus.lastError}` : ''}</small>
    </div>
    <div className="glass-card settings-platform-subsection settings-calendar-config">
      <h3>公司行动自动同步</h3>
      <p>开启后仅在打开应用时检查：A 股、港股在北京时间 18:00 后最多同步一次；美股在北京时间 08:00 后最多同步一次。同步只保存待确认候选，不会自动修改账本。</p>
      <label className="settings-auto-sync-toggle"><input type="checkbox" checked={corporateActionAutoSync} onChange={(event) => void saveCorporateActionAutoSync(event.target.checked)} /><span>打开应用时自动检查拆并股</span></label>
      <small>当天已尝试的市场不会重复请求；手动同步不受此限制。</small>
    </div>
    {message && <p className="settings-feedback">{message}</p>}
  </section>;
}
