import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArchiveRestore, ChevronRight, Database, FileText, Inbox, Mail, RefreshCw, ShieldAlert } from 'lucide-react';
import { isAndroidNativeRuntime, nativeEmailSync, type NativeEmailSyncConfig } from '../platform/nativeRuntime';
import { userFacingError } from '../shared/userMessages';

const maskedAccount = (account: string) => {
  const at = account.indexOf('@');
  return at > 1 ? `${account.slice(0, 2)}***${account.slice(at)}` : account;
};

export default function DataPage() {
  const navigate = useNavigate();
  const isAndroid = isAndroidNativeRuntime();
  const [mailboxes, setMailboxes] = useState<NativeEmailSyncConfig[]>([]);
  const [syncing, setSyncing] = useState('');
  const [mailMessage, setMailMessage] = useState('');
  const refreshMailboxes = useCallback(async () => {
    if (!isAndroid) return;
    setMailboxes((await nativeEmailSync.status()).configs.filter((config) => config.passwordConfigured));
  }, [isAndroid]);
  useEffect(() => { void refreshMailboxes(); }, [refreshMailboxes]);
  const syncMailbox = async (mailbox: NativeEmailSyncConfig) => {
    setSyncing(mailbox.mailboxId); setMailMessage('');
    try { const result = await nativeEmailSync.syncNow({ mailboxId: mailbox.mailboxId }); setMailMessage(result.message); await refreshMailboxes(); }
    catch (error) { setMailMessage(`同步失败：${userFacingError(error, 'sync')}`); }
    finally { setSyncing(''); }
  };

  const entries = [
    { title: '数据备份', desc: '导出或恢复本地账本数据，可在设备间迁移。', icon: ArchiveRestore, path: '/data/backup' },
    { title: '历史行情', desc: '查看、导入、导出和补齐历史行情数据。', icon: Database, path: '/data/cache' },
    { title: '电子结单导入', desc: '导入已适配的 CSV 交易记录或文本型 PDF 结单。', icon: FileText, path: '/data/imports' },
    { title: '公司行动', desc: '同步并确认股票拆并股，处理到期期权。', icon: ShieldAlert, path: '/data/corporate-actions' },
  ];

  return <div className="page tab-page data-page">
    <div className="data-entry-list">{entries.map(({ title, desc, icon: Icon, path }) => <button key={title} className="data-entry-card" onClick={() => navigate(path)}>
      <span className="data-entry-icon"><Icon size={21} /></span><span className="data-entry-copy"><strong>{title}</strong><small>{desc}</small></span><ChevronRight size={20} className="text-muted" />
    </button>)}</div>
    {isAndroid && mailboxes.length > 0 && <section className="data-email-card">
      <div className="data-email-heading"><span><Mail size={19} /><strong>邮箱手动同步</strong></span><button type="button" onClick={() => navigate('/data/email-imports')}><Inbox size={16} />查看待确认导入</button></div>
      <p>邮箱账号在设置页管理。同步邮件只会进入待确认收件箱，不会直接写入账本。</p>
      <div className="data-email-mailboxes">{mailboxes.map((mailbox) => <div key={mailbox.mailboxId}>
        <span><strong>{mailbox.provider === 'ZHUORUI' ? '卓锐证券' : '嘉信国际'}</strong><small>{maskedAccount(mailbox.account)} · {mailbox.lastStatus || '未同步'}</small></span>
        <button type="button" className="primary" onClick={() => void syncMailbox(mailbox)} disabled={Boolean(syncing)}><RefreshCw size={16} className={syncing === mailbox.mailboxId ? 'spin' : undefined} />{syncing === mailbox.mailboxId ? '同步中…' : '立即同步'}</button>
      </div>)}</div>
      {mailMessage && <small className={mailMessage.startsWith('同步失败') ? 'error' : ''}>{mailMessage}</small>}
    </section>}
    <div className="data-page-note"><Inbox size={18} />导入的数据均会先展示预览；重复和冲突不会被静默覆盖。</div>
  </div>;
}
