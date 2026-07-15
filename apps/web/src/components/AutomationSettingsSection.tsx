import { useEffect, useState } from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { db } from '../db/localDb';
import { getStockCalendarStatus, syncStockCalendar } from '../core/market/stockCalendarProvider';
import { CORPORATE_ACTION_AUTO_SYNC_KEY, DEFAULT_CORPORATE_ACTION_AUTO_SYNC } from '../core/corporateActions/splitActionService';

export default function AutomationSettingsSection() {
  const [calendarStatus, setCalendarStatus] = useState<{ configured: boolean; fetchedAt?: number; lastError?: string; recordCount: number }>({ configured: false, recordCount: 0 });
  const [calendarSyncing, setCalendarSyncing] = useState(false);
  const [corporateActionAutoSync, setCorporateActionAutoSync] = useState(DEFAULT_CORPORATE_ACTION_AUTO_SYNC);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void (async () => {
      const [calendarSetting, corporateActionSetting] = await Promise.all([
        getStockCalendarStatus(),
        db.appSettings.get(CORPORATE_ACTION_AUTO_SYNC_KEY),
      ]);
      setCorporateActionAutoSync(typeof corporateActionSetting?.value === 'boolean' ? corporateActionSetting.value : DEFAULT_CORPORATE_ACTION_AUTO_SYNC);
      setCalendarStatus(calendarSetting);
    })();
  }, []);

  const syncCalendar = async (force = false) => {
    setCalendarSyncing(true);
    try {
      const cache = await syncStockCalendar(force);
      const status = await getStockCalendarStatus();
      setCalendarStatus(status);
      return cache;
    } finally {
      setCalendarSyncing(false);
    }
  };

  const refreshCalendar = async () => {
    const cache = await syncCalendar(true);
    setMessage(cache.lastError ? `交易日历同步未完成：${cache.lastError}` : '交易日历已刷新；后续只在缓存未覆盖最近交易日时增量更新。');
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
      <p>港股和美股通过 stock-sdk 的公开日 K 线推断已结束交易日，A 股继续使用 stock-sdk。无需账号、Token 或额外配置。</p>
      <div className="settings-inline-actions"><button type="button" className="primary settings-save-button" onClick={() => void refreshCalendar()} disabled={calendarSyncing}><RefreshCw size={15} className={calendarSyncing ? 'spin' : undefined} />{calendarSyncing ? '刷新中…' : '立即刷新'}</button></div>
      <small>最近同步：{calendarUpdatedAt}；已缓存 {calendarStatus.recordCount} 个市场年度{calendarStatus.lastError ? `；最近一次提示：${calendarStatus.lastError}` : ''}</small>
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
