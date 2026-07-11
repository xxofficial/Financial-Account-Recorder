import { useEffect, useState } from 'react';
import { Mail, RefreshCw, Save } from 'lucide-react';
import { nativeEmailSync, type NativeEmailSyncConfig } from '../platform/nativeRuntime';

type Provider = NativeEmailSyncConfig['provider'];

interface FormState {
  provider: Provider;
  imapHost: string;
  imapPort: number;
  account: string;
  folder: string;
  autoSync: boolean;
}

const emptyForm = (provider: Provider): FormState => ({
  provider,
  imapHost: '',
  imapPort: 993,
  account: '',
  folder: 'INBOX',
  autoSync: false,
});

const toForm = (config: NativeEmailSyncConfig): FormState => ({
  provider: config.provider,
  imapHost: config.imapHost,
  imapPort: config.imapPort,
  account: config.account,
  folder: config.folder,
  autoSync: config.autoSync,
});

export default function AndroidEmailSyncCard({ onSynced }: { onSynced: () => Promise<void> }) {
  const [configs, setConfigs] = useState<NativeEmailSyncConfig[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm('ZHUORUI'));
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const currentConfig = configs.find((config) => config.provider === form.provider);

  const refresh = async (keepProvider = true) => {
    const status = await nativeEmailSync.status();
    setConfigs(status.configs);
    if (!keepProvider) return;
    const saved = status.configs.find((config) => config.provider === form.provider);
    if (saved) setForm(toForm(saved));
  };

  useEffect(() => {
    void refresh();
  // The native plugin is immutable for a mounted app session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (): Promise<boolean> => {
    setBusy(true);
    try {
      const saved = await nativeEmailSync.configure({ ...form, password: password || undefined });
      setPassword('');
      setConfigs((current) => [...current.filter((config) => config.provider !== saved.provider), saved]);
      setForm(toForm(saved));
      setMessage(saved.autoSync ? '配置已保存，后台同步每 15 分钟运行一次。' : '配置已保存；可按需手动同步。');
      return true;
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const result = await nativeEmailSync.syncNow({ provider: form.provider });
      setMessage(result.message);
      await refresh();
      await onSynced();
    } catch (error) {
      setMessage(`同步失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const changeProvider = (provider: Provider) => {
    const saved = configs.find((config) => config.provider === provider);
    setForm(saved ? toForm(saved) : emptyForm(provider));
    setPassword('');
    setMessage('');
  };

  const inputStyle = { width: '100%', fontSize: '0.8rem', padding: '0.45rem 0.55rem' };

  return (
    <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Mail size={18} style={{ color: 'var(--accent)' }} />
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Android 邮件同步</h3>
      </div>
      <p className="text-xs text-muted" style={{ margin: 0 }}>
        仅 Android 支持 IMAP 后台同步。邮件正文先进入待导入收件箱，绝不由后台直接写入账本；邮箱密码或应用专用密码只保存于 Android Keystore。
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <select value={form.provider} onChange={(event) => changeProvider(event.target.value as Provider)} style={inputStyle}>
          <option value="ZHUORUI">卓锐证券</option>
          <option value="SCHWAB">嘉信国际</option>
        </select>
        <input value={form.folder} onChange={(event) => setForm({ ...form, folder: event.target.value })} placeholder="文件夹，如 INBOX" style={inputStyle} />
        <input value={form.imapHost} onChange={(event) => setForm({ ...form, imapHost: event.target.value })} placeholder="IMAP 地址" style={inputStyle} />
        <input type="number" min="1" max="65535" value={form.imapPort} onChange={(event) => setForm({ ...form, imapPort: Number(event.target.value) || 993 })} placeholder="端口" style={inputStyle} />
        <input value={form.account} onChange={(event) => setForm({ ...form, account: event.target.value })} placeholder="邮箱账号" style={{ ...inputStyle, gridColumn: '1 / -1' }} />
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={currentConfig?.passwordConfigured ? '已安全保存；留空不改变' : '邮箱密码或应用专用密码'} style={{ ...inputStyle, gridColumn: '1 / -1' }} />
      </div>
      <label className="text-xs" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        <input type="checkbox" checked={form.autoSync} onChange={(event) => setForm({ ...form, autoSync: event.target.checked })} />
        启用后台同步（Android 最短 15 分钟间隔）
      </label>
      {currentConfig?.lastStatus && <div className="text-xs text-muted">上次状态：{currentConfig.lastStatus}</div>}
      {message && <div className="text-xs" style={{ color: message.startsWith('同步失败') || message.startsWith('保存失败') ? 'var(--color-error)' : 'var(--text-secondary)' }}>{message}</div>}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button type="button" onClick={() => void save()} disabled={busy} style={{ flex: 1, padding: '0.45rem', fontSize: '0.8rem' }}><Save size={14} /> 保存配置</button>
        <button type="button" className="primary" onClick={() => void syncNow()} disabled={busy || !currentConfig?.passwordConfigured} style={{ flex: 1, padding: '0.45rem', fontSize: '0.8rem' }}><RefreshCw size={14} className={busy ? 'spin' : undefined} /> 立即同步</button>
      </div>
    </div>
  );
}
