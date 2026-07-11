import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { isAndroidNativeRuntime, nativeAppUpdate, type NativeAppUpdate } from '../platform/nativeRuntime';

export default function AppUpdateCard() {
  const [result, setResult] = useState<NativeAppUpdate | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isAndroidNativeRuntime()) return null;
  const check = async () => { setBusy(true); try { setResult(await nativeAppUpdate.check()); } finally { setBusy(false); } };
  const install = async () => { if (!result?.downloadUrl || !result.assetName) return; setBusy(true); try { await nativeAppUpdate.downloadAndInstall({ downloadUrl: result.downloadUrl, assetName: result.assetName }); } finally { setBusy(false); } };
  return <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <h3 style={{ margin: 0, fontSize: '0.95rem' }}>应用更新</h3>
    <div className="text-xs text-muted">当前版本：{result?.currentVersionName ?? '—'}。正式 Release 的 APK 文件名必须以 <code>-versionCode.apk</code> 结尾。</div>
    {result && <div className="text-xs">{result.message}{result.latestVersionName ? `：${result.latestVersionName}` : ''}</div>}
    <div style={{ display: 'flex', gap: 8 }}><button onClick={() => void check()} disabled={busy} style={{ flex: 1 }}><RefreshCw size={14} className={busy ? 'spin' : undefined} />检查更新</button>{result?.hasUpdate && <button className="primary" onClick={() => void install()} disabled={busy} style={{ flex: 1 }}><Download size={14} />下载并安装</button>}</div>
  </div>;
}
