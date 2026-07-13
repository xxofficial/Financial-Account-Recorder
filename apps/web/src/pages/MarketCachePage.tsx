import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { marketCacheManager, MarketCacheImportReport } from '../core/market/marketCacheManager';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import {
  Download,
  Upload,
  CheckCircle,
  XCircle,
  Database,
  FileText,
  RefreshCw,
  HardDrive,
  Layers,
  Calendar,
  BarChart3,
} from 'lucide-react';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';

export default function MarketCachePage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importReport, setImportReport] = useState<MarketCacheImportReport | null>(null);
  const [importStatus, setImportStatus] = useState<'IDLE' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [overwriteMode, setOverwriteMode] = useState(false);
  const [gzipExport, setGzipExport] = useState(false);
  const [detectSummary, setDetectSummary] = useState<{ queued: number; items: { securityKey: string; fromDate: string; toDate: string }[] } | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const coverage = useLiveQuery(async () => {
    return db.historicalCoverage.orderBy('updatedAt').reverse().toArray();
  }) ?? [];

  const workItems = useLiveQuery(async () => {
    return db.marketWorkItems.toArray();
  }) ?? [];

  const barsCount = useLiveQuery(async () => {
    return db.historicalBars.count();
  }) ?? 0;

  const queueStats = (() => {
    const stats = {
      pending: 0,
      running: 0,
      retry_scheduled: 0,
      paused_quota: 0,
      success: 0,
      failed: 0,
      no_data: 0,
      failed_permanent: 0,
      unsupported: 0,
    };
    for (const item of workItems) {
      if (item.status in stats) {
        (stats as any)[item.status]++;
      }
    }
    return stats;
  })();

  const pendingCount = queueStats.pending + queueStats.running + queueStats.retry_scheduled + queueStats.paused_quota;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      setImportStatus('IDLE');
      setErrorMessage('');
      setImportReport(null);
    }
  };

  const handleImport = async () => {
    if (!selectedFile) return;
    setIsImporting(true);
    setImportStatus('IDLE');
    setErrorMessage('');
    try {
      const report = await marketCacheManager.importMarketCache(selectedFile, { overwrite: overwriteMode });
      setImportReport(report);
      setImportStatus('SUCCESS');
      setSelectedFile(null);
    } catch (err: any) {
      setErrorMessage(err.message || '导入行情缓存失败');
      setImportStatus('ERROR');
    } finally {
      setIsImporting(false);
    }
  };

  const handleExportCache = async () => {
    try {
      const { blob, fileName } = await marketCacheManager.exportMarketCacheBlob({ gzip: gzipExport });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`导出失败: ${err.message || err}`);
    }
  };

  const handleExportMissing = async () => {
    try {
      const { blob, fileName } = await marketCacheManager.exportMissingMarketData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`导出缺失清单失败: ${err.message || err}`);
    }
  };

  const handleDetectMissing = async () => {
    setIsDetecting(true);
    setDetectSummary(null);
    try {
      const summary = await marketCacheManager.detectAndQueueMissingRanges();
      setDetectSummary(summary);
    } catch (err: any) {
      setErrorMessage(err.message || '检测缺失区间失败');
      setImportStatus('ERROR');
    } finally {
      setIsDetecting(false);
    }
  };

  const handleStartSync = async () => {
    setIsSyncing(true);
    try {
      await MarketTaskExecutor.startOrWakeMarketExecutor();
    } catch (err: any) {
      alert(`启动同步失败: ${err.message || err}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '-';
    const dt = new Date(timestamp);
    return `${dt.getFullYear()}-${(dt.getMonth() + 1).toString().padStart(2, '0')}-${dt.getDate().toString().padStart(2, '0')} ${dt.getHours().toString().padStart(2, '0')}:${dt.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="page page-secondary market-cache-page">
      <SecondaryPageHeader title="行情缓存管理" fallback="/data" />

      {/* Stats overview */}
      <div className="glass-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="text-xs text-muted">缓存 K 线数</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>{barsCount}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div className="text-xs text-muted">覆盖标的</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>{coverage.length}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div className="text-xs text-muted">待同步任务</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: pendingCount > 0 ? 'var(--color-warning)' : 'var(--color-success)' }}>{pendingCount}</div>
        </div>
      </div>

      {/* Import Section */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Upload size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>导入行情缓存</h3>
        </div>
        <p className="text-sm text-muted">
          选择外部预取工具生成的 market-cache-v1.json / .json.gz。默认只补充缺失数据，不覆盖已有数据。
        </p>

        <div style={{
          border: '2px dashed var(--border-color)',
          borderRadius: '10px',
          padding: '1.25rem 1rem',
          textAlign: 'center',
          backgroundColor: 'rgba(31, 41, 55, 0.15)',
          cursor: 'pointer',
          position: 'relative',
          transition: 'all 0.2s ease',
        }}>
          <Upload size={28} style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }} />
          <div className="text-sm" style={{ fontWeight: 600 }}>
            {selectedFile ? '已选择文件' : '点击选择缓存文件'}
          </div>
          <div className="text-xs text-muted" style={{ marginTop: '0.25rem' }}>
            {selectedFile ? selectedFile.name : '支持 *.json / *.json.gz'}
          </div>
          <input
            type="file"
            accept=".json,.json.gz,.gz"
            onChange={handleFileChange}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={overwriteMode}
            onChange={(e) => setOverwriteMode(e.target.checked)}
          />
          高级：覆盖已有数据（导入报告中会显示原数据来源和更新时间）
        </label>

        <button
          className="primary"
          onClick={handleImport}
          disabled={!selectedFile || isImporting}
          style={{ width: '100%', marginTop: '0.25rem' }}
        >
          {isImporting ? <RefreshCw size={16} className="spin" /> : <Upload size={16} />}
          {isImporting ? ' 导入中...' : ' 开始导入'}
        </button>

        {importStatus === 'ERROR' && errorMessage && (
          <div style={{ padding: '0.75rem', backgroundColor: 'var(--color-error-bg)', border: '1px solid var(--color-error-border)', borderRadius: '8px', display: 'flex', gap: '0.5rem', color: '#fca5a5', fontSize: '0.8rem' }}>
            <XCircle size={16} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
            <div>{errorMessage}</div>
          </div>
        )}

        {importStatus === 'SUCCESS' && importReport && (
          <div style={{ padding: '0.75rem', backgroundColor: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '0.5rem', color: '#a7f3d0', fontSize: '0.85rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <CheckCircle size={16} style={{ flexShrink: 0 }} />
              <span>导入成功！</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.75rem' }}>
              <div>文件总数: {importReport.totalInFile}</div>
              <div>有效: {importReport.valid}</div>
              <div>无效: {importReport.invalid}</div>
              <div>已插入: {importReport.inserted}</div>
              <div>已跳过: {importReport.skipped}</div>
              <div>已覆盖: {importReport.overwritten}</div>
            </div>
            {importReport.invalidDetails.length > 0 && (
              <div style={{ maxHeight: '120px', overflowY: 'auto', backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: '6px', padding: '0.5rem' }}>
                <div className="text-xs" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>校验失败的行：</div>
                {importReport.invalidDetails.slice(0, 10).map((d, i) => (
                  <div key={i} style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>
                    行 {d.row + 1}: {d.reason}
                  </div>
                ))}
                {importReport.invalidDetails.length > 10 && (
                  <div style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>... 还有 {importReport.invalidDetails.length - 10} 条</div>
                )}
              </div>
            )}
            {importReport.overwrittenDetails.length > 0 && (
              <div style={{ maxHeight: '120px', overflowY: 'auto', backgroundColor: 'rgba(0,0,0,0.15)', borderRadius: '6px', padding: '0.5rem' }}>
                <div className="text-xs" style={{ fontWeight: 600, marginBottom: '0.25rem' }}>被覆盖的数据来源：</div>
                {importReport.overwrittenDetails.slice(0, 10).map((d, i) => (
                  <div key={i} style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>
                    {d.securityKey} @ {d.tradeDate} — 原来源: {d.oldSourceName || d.oldProviderId || '未知'}, 更新时间: {formatDate(d.oldFetchedAt)}
                  </div>
                ))}
                {importReport.overwrittenDetails.length > 10 && (
                  <div style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>... 还有 {importReport.overwrittenDetails.length - 10} 条</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Export Section */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Download size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>导出行情缓存</h3>
        </div>
        <p className="text-sm text-muted">
          将当前本地 historicalBars / historicalCoverage 导出为 market-cache-v1.json，供外部工具或备份使用。
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={gzipExport} onChange={(e) => setGzipExport(e.target.checked)} />
          使用 gzip 压缩（.json.gz）
        </label>
        <button className="primary" onClick={handleExportCache} style={{ width: '100%' }}>
          <Download size={16} />
          导出行情缓存
        </button>
      </div>

      {/* Missing List Export */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileText size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>导出缺失历史行情清单</h3>
        </div>
        <p className="text-sm text-muted">
          导出当前队列中仍缺失的 historical_range_fill / daily_close_update 任务，交给桌面预取工具批量拉取。
        </p>
        <button className="primary" onClick={handleExportMissing} style={{ width: '100%' }}>
          <Download size={16} />
          导出 missing-market-data-v1.json
        </button>
      </div>

      {/* Detect & Sync */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <BarChart3 size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>检测并补齐缺失</h3>
        </div>
        <p className="text-sm text-muted">
          根据当前交易记录检测历史行情缺口，将缺失区间写入队列。确认后再点击“开始同步”拉取行情。
        </p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={handleDetectMissing} disabled={isDetecting} style={{ flex: 1 }}>
            {isDetecting ? <RefreshCw size={16} className="spin" /> : <Layers size={16} />}
            {isDetecting ? ' 检测中...' : ' 检测缺失区间'}
          </button>
          <button className="success" onClick={handleStartSync} disabled={isSyncing || pendingCount === 0} style={{ flex: 1 }}>
            {isSyncing ? <RefreshCw size={16} className="spin" /> : <RefreshCw size={16} />}
            {isSyncing ? ' 同步中...' : ' 开始同步'}
          </button>
        </div>
        {detectSummary && (
          <div style={{ padding: '0.75rem', backgroundColor: 'var(--color-info-bg)', border: '1px solid var(--color-info-border)', borderRadius: '8px', color: '#a5f3fc', fontSize: '0.8rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
              检测到 {detectSummary.queued} 个缺失区间
            </div>
            <div style={{ maxHeight: '120px', overflowY: 'auto' }}>
              {detectSummary.items.slice(0, 10).map((item, i) => (
                <div key={i} style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>
                  {item.securityKey}: {item.fromDate} ~ {item.toDate}
                </div>
              ))}
              {detectSummary.items.length > 10 && (
                <div style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}>... 还有 {detectSummary.items.length - 10} 个</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Coverage Table */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <HardDrive size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>缓存覆盖范围</h3>
        </div>
        {coverage.length === 0 ? (
          <div className="text-xs text-muted" style={{ textAlign: 'center', padding: '1rem 0' }}>
            暂无 historicalCoverage 记录
          </div>
        ) : (
          <div className="table-container" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                  <th style={{ padding: '0.5rem' }}>标的</th>
                  <th style={{ padding: '0.5rem' }}>区间</th>
                  <th style={{ padding: '0.5rem' }}>状态</th>
                  <th style={{ padding: '0.5rem' }}>来源</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((cov) => (
                  <tr key={cov.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '0.5rem' }}>{cov.securityKey}</td>
                    <td style={{ padding: '0.5rem' }}>
                      <Calendar size={12} style={{ display: 'inline', marginRight: '0.25rem', verticalAlign: 'text-bottom' }} />
                      {cov.fromDate} ~ {cov.toDate}
                    </td>
                    <td style={{ padding: '0.5rem' }}>
                      <span className={`badge ${cov.coverageStatus === 'complete' ? 'success' : cov.coverageStatus === 'partial' ? 'warning' : 'secondary'}`}>
                        {cov.coverageStatus === 'complete' ? '完整' : cov.coverageStatus === 'partial' ? '部分' : '未知'}
                      </span>
                    </td>
                    <td style={{ padding: '0.5rem', color: 'var(--text-muted)' }}>
                      {cov.sourceName || cov.providerId || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Queue Summary */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Database size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>队列摘要</h3>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.75rem' }}>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '0.5rem', borderRadius: '6px', textAlign: 'center' }}>
            <div className="text-muted">待处理</div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{queueStats.pending + queueStats.running}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '0.5rem', borderRadius: '6px', textAlign: 'center' }}>
            <div className="text-muted">成功</div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--color-success)' }}>{queueStats.success}</div>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.02)', padding: '0.5rem', borderRadius: '6px', textAlign: 'center' }}>
            <div className="text-muted">失败/受限</div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--color-error)' }}>{queueStats.failed + queueStats.failed_permanent + queueStats.paused_quota + queueStats.retry_scheduled}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
