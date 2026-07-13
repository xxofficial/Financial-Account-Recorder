import { useEffect, useState } from 'react';
import { Mail, Plus, Save, Trash2 } from 'lucide-react';
import { nativeEmailSync, type NativeEmailSyncConfig } from '../platform/nativeRuntime';

type Provider = NativeEmailSyncConfig['provider'];
type FormState = Omit<NativeEmailSyncConfig, 'mailboxId' | 'passwordConfigured' | 'lastSyncAt' | 'lastStatus'>;

const emptyForm = (): FormState => ({ provider: 'ZHUORUI', imapHost: '', imapPort: 993, account: '', folder: 'INBOX', autoSync: false });
const toForm = (config: NativeEmailSyncConfig): FormState => ({ provider: config.provider, imapHost: config.imapHost, imapPort: config.imapPort, account: config.account, folder: config.folder, autoSync: config.autoSync });
const maskedAccount = (account: string) => {
  const at = account.indexOf('@');
  if (at <= 1) return account;
  return `${account.slice(0, 2)}***${account.slice(at)}`;
};

export default function AndroidEmailSyncCard() {
  const [configs, setConfigs] = useState<NativeEmailSyncConfig[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => setConfigs((await nativeEmailSync.status()).configs);
  useEffect(() => { void refresh(); }, []);
  const editing = configs.find((config) => config.mailboxId === editingId);

  const add = () => { setEditingId('new'); setForm(emptyForm()); setPassword(''); setMessage(''); };
  const edit = (config: NativeEmailSyncConfig) => { setEditingId(config.mailboxId); setForm(toForm(config)); setPassword(''); setMessage(''); };
  const close = () => { setEditingId(null); setPassword(''); setMessage(''); };
  const save = async () => {
    setBusy(true);
    try {
      const saved = await nativeEmailSync.configure({ ...form, mailboxId: editingId === 'new' ? undefined : editingId ?? undefined, password: password || undefined });
      await refresh(); setEditingId(saved.mailboxId); setForm(toForm(saved)); setPassword('');
      setMessage(saved.autoSync ? '配置已保存，后台同步最短每 15 分钟运行一次。' : '配置已保存；可在数据页手动同步。');
    } catch (error) { setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  const remove = async (config: NativeEmailSyncConfig) => {
    if (!window.confirm(`删除 ${maskedAccount(config.account)} 的邮箱配置？Android Keystore 中的密码也会删除。`)) return;
    setBusy(true);
    try { await nativeEmailSync.remove({ mailboxId: config.mailboxId }); await refresh(); if (editingId === config.mailboxId) close(); }
    catch (error) { setMessage(`删除失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };

  return <section className="android-email-settings surface-card">
    <div className="android-email-heading"><span><Mail size={18} /><strong>邮箱同步</strong></span><button type="button" onClick={add} disabled={busy}><Plus size={16} />添加邮箱</button></div>
    <p>仅 Android 支持 IMAP 后台同步。邮件会先进入待确认收件箱；密码或应用专用密码仅保存于 Android Keystore。</p>
    {configs.length > 0 && <div className="android-email-list">{configs.map((config) => <div key={config.mailboxId} className="android-email-row">
      <button type="button" className="android-email-summary" onClick={() => edit(config)}><span><strong>{config.provider === 'ZHUORUI' ? '卓锐证券' : '嘉信国际'}</strong><small>{maskedAccount(config.account)} · {config.folder}</small></span><small>{config.autoSync ? '自动同步已开启' : '仅手动同步'}<br />{config.lastStatus || '未同步'}</small></button>
      <button type="button" className="android-email-delete" aria-label="删除邮箱配置" onClick={() => void remove(config)} disabled={busy}><Trash2 size={17} /></button>
    </div>)}</div>}
    {editingId && <div className="android-email-form">
      <h4>{editingId === 'new' ? '添加邮箱' : '编辑邮箱'}</h4>
      <div className="android-email-form-grid">
        <label>所属平台<select value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value as Provider })}><option value="ZHUORUI">卓锐证券</option><option value="SCHWAB">嘉信国际</option></select></label>
        <label>文件夹<input value={form.folder} onChange={(event) => setForm({ ...form, folder: event.target.value })} placeholder="INBOX" /></label>
        <label>IMAP 地址<input value={form.imapHost} onChange={(event) => setForm({ ...form, imapHost: event.target.value })} placeholder="如 imap.qq.com" /></label>
        <label>端口<input type="number" min="1" max="65535" value={form.imapPort} onChange={(event) => setForm({ ...form, imapPort: Number(event.target.value) || 993 })} /></label>
        <label className="full">邮箱账号<input value={form.account} onChange={(event) => setForm({ ...form, account: event.target.value })} /></label>
        <label className="full">密码 / 应用专用密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={editing?.passwordConfigured ? '已安全保存；留空不改变' : '首次保存必填'} /></label>
      </div>
      <label className="android-email-auto"><input type="checkbox" checked={form.autoSync} onChange={(event) => setForm({ ...form, autoSync: event.target.checked })} />启用后台同步（Android 最短 15 分钟间隔）</label>
      {message && <p className={message.startsWith('保存失败') || message.startsWith('删除失败') ? 'error' : ''}>{message}</p>}
      <div className="android-email-form-actions"><button type="button" onClick={close}>取消</button><button type="button" className="primary" onClick={() => void save()} disabled={busy}><Save size={16} />保存邮箱</button></div>
    </div>}
  </section>;
}
