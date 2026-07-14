import React, { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { getHistoricalRangeRequestsFromTransactions, marketCacheManager, MarketCacheImportReport } from '../core/market/marketCacheManager';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';
import {
  Download,
  Upload,
  CheckCircle,
  XCircle,
  FileText,
  RefreshCw,
  HardDrive,
  Layers,
  BarChart3,
  AlertTriangle,
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

  const canonicalBars = useLiveQuery(() => db.historicalBars.where('resolution').equals('1d').toArray()) ?? [];
  const barsCount = useLiveQuery(async () => {
    return db.historicalBars.count();
  }) ?? 0;

  const requiredTransactions = useLiveQuery(() => db.transactions.toArray());
  const [requiredRanges, setRequiredRanges] = useState<Awaited<ReturnType<typeof getHistoricalRangeRequestsFromTransactions>>>([]);
  useEffect(() => {
    let active = true;
    void getHistoricalRangeRequestsFromTransactions(requiredTransactions ?? []).then((ranges) => {
      if (active) setRequiredRanges(ranges);
    });
    return () => { active = false; };
  }, [requiredTransactions]);

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
  const missingRequired = requiredRanges.filter((required) => {
    const covered = coverage.some((item) => item.securityKey === required.securityKey && item.coverageStatus === 'complete' && item.fromDate <= required.fromDate && item.toDate >= required.toDate);
    const hasBars = canonicalBars.some((bar) => bar.securityKey === required.securityKey && bar.tradeDate >= required.fromDate && bar.tradeDate <= required.toDate);
    return !covered || !hasBars;
  });
  const incompleteCoverage = coverage.filter((item) => item.coverageStatus !== 'complete');
  const pendingCoverageCount = incompleteCoverage.length + missingRequired.length;
  const cacheHealth = requiredRanges.length > 0 && pendingCoverageCount > 0
    ? 'attention'
    : coverage.length === 0 && barsCount === 0
    ? 'empty'
    : pendingCount > 0
      ? 'attention'
      : 'ready';

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

      <section className="market-cache-section" aria-labelledby="market-cache-overview-title">
        <div className="market-cache-section-heading">
          <div>
            <h2 id="market-cache-overview-title">缓存概览</h2>
            <p>本地保存的历史行情会优先用于分析和收益计算。</p>
          </div>
          <HardDrive size={20} aria-hidden="true" />
        </div>
        <div className="market-cache-overview-grid">
          <div><span>缓存 K 线数</span><strong>{barsCount.toLocaleString()}</strong></div>
          <div><span>已覆盖标的</span><strong>{coverage.length}</strong></div>
          <div><span>待补齐标的</span><strong className={pendingCoverageCount > 0 ? 'is-warning' : ''}>{pendingCoverageCount}</strong></div>
          <div><span>同步任务</span><strong className={pendingCount > 0 ? 'is-warning' : 'is-success'}>{pendingCount}</strong></div>
        </div>
      </section>

      <section className="market-cache-section" aria-labelledby="market-cache-health-title">
        <div className="market-cache-section-heading">
          <div>
            <h2 id="market-cache-health-title">缓存健康</h2>
            <p>只显示需要关注的行情状态。</p>
          </div>
          {cacheHealth === 'ready' ? <CheckCircle size={20} className="is-success" aria-hidden="true" /> : <AlertTriangle size={20} className="is-warning" aria-hidden="true" />}
        </div>
        <div className={`market-cache-health-state is-${cacheHealth}`}>
          {cacheHealth === 'ready' && <CheckCircle size={18} aria-hidden="true" />}
          {cacheHealth === 'attention' && <AlertTriangle size={18} aria-hidden="true" />}
          {cacheHealth === 'empty' && <HardDrive size={18} aria-hidden="true" />}
          <div>
            <strong>
              {cacheHealth === 'ready' ? '历史行情缓存已就绪' : cacheHealth === 'attention' ? '部分行情需要处理' : '尚未建立行情缓存'}
            </strong>
            <span>
              {cacheHealth === 'ready'
                ? '当前没有待补齐的覆盖范围或同步任务。'
                : cacheHealth === 'attention'
                  ? `${pendingCoverageCount} 个标的待补齐，${pendingCount} 个任务在队列中。`
                  : '可通过检测缺失区间或导入缓存备份开始建立数据。'}
            </span>
          </div>
        </div>
        {pendingCoverageCount > 0 && (
          <div className="market-cache-attention-list">
            {incompleteCoverage.slice(0, 6).map((cov) => (
              <div className="market-cache-attention-row" key={cov.id ?? `${cov.securityKey}-${cov.fromDate}`}>
                <div>
                  <strong>{cov.securityKey}</strong>
                  <span>{cov.fromDate} ~ {cov.toDate} · {cov.sourceName || cov.providerId || '来源未知'}</span>
                </div>
                <span className={`market-cache-status is-${cov.coverageStatus}`}>
                  {cov.coverageStatus === 'partial' ? '部分覆盖' : '待确认'}
                </span>
              </div>
            ))}
            {incompleteCoverage.length > 6 && <p className="market-cache-more-hint">还有 {incompleteCoverage.length - 6} 个标的，请先检测缺失区间。</p>}
            {missingRequired.slice(0, 6).map((item) => <div className="market-cache-attention-row" key={`missing-${item.securityKey}`}><div><strong>{item.securityKey}</strong><span>{item.fromDate} ~ {item.toDate} · 尚未发现有效覆盖</span></div><span className="market-cache-status is-partial">待补齐</span></div>)}
          </div>
        )}
      </section>

      <section className="market-cache-section" aria-labelledby="market-cache-sync-title">
        <div className="market-cache-section-heading">
          <div>
            <h2 id="market-cache-sync-title">同步与缺失</h2>
            <p>根据交易记录检测历史行情缺口，确认后再加入同步队列。</p>
          </div>
          <BarChart3 size={20} aria-hidden="true" />
        </div>
        <div className="market-cache-action-grid">
          <button onClick={handleDetectMissing} disabled={isDetecting}>
            {isDetecting ? <RefreshCw size={16} className="spin" /> : <Layers size={16} />}
            {isDetecting ? '检测中…' : '检测缺失区间'}
          </button>
          <button className="success" onClick={handleStartSync} disabled={isSyncing || pendingCount === 0}>
            {isSyncing ? <RefreshCw size={16} className="spin" /> : <RefreshCw size={16} />}
            {isSyncing ? '同步中…' : '开始同步'}
          </button>
        </div>
        {detectSummary && (
          <div className="market-cache-inline-status is-info">
            <strong>检测到 {detectSummary.queued} 个缺失区间</strong>
            {detectSummary.items.length > 0 && (
              <div className="market-cache-result-list">
                {detectSummary.items.slice(0, 6).map((item, i) => <span key={i}>{item.securityKey}：{item.fromDate} ~ {item.toDate}</span>)}
                {detectSummary.items.length > 6 && <span>还有 {detectSummary.items.length - 6} 个区间</span>}
              </div>
            )}
          </div>
        )}
        <button className="market-cache-text-action" onClick={handleExportMissing}>
          <FileText size={16} />
          导出缺失历史行情清单
        </button>
      </section>

      <section className="market-cache-section" aria-labelledby="market-cache-backup-title">
        <div className="market-cache-section-heading">
          <div>
            <h2 id="market-cache-backup-title">缓存备份</h2>
            <p>使用 market-cache-v1 文件在设备之间备份或迁移行情数据。</p>
          </div>
          <Upload size={20} aria-hidden="true" />
        </div>
        <label className="market-cache-file-row">
          <span className="market-cache-file-icon"><Upload size={18} aria-hidden="true" /></span>
          <span className="market-cache-file-copy">
            <strong>{selectedFile ? '已选择缓存文件' : '选择缓存文件'}</strong>
            <small>{selectedFile ? selectedFile.name : '支持 .json / .json.gz'}</small>
          </span>
          <input type="file" accept=".json,.json.gz,.gz" onChange={handleFileChange} />
        </label>
        <label className="market-cache-setting-row">
          <span><strong>覆盖已有数据</strong><small>导入报告会保留原来源和更新时间</small></span>
          <input type="checkbox" checked={overwriteMode} onChange={(e) => setOverwriteMode(e.target.checked)} />
        </label>
        <button className="primary" onClick={handleImport} disabled={!selectedFile || isImporting}>
          {isImporting ? <RefreshCw size={16} className="spin" /> : <Upload size={16} />}
          {isImporting ? '导入中…' : '开始导入'}
        </button>
        <div className="market-cache-divider" />
        <label className="market-cache-setting-row">
          <span><strong>Gzip 压缩导出</strong><small>生成体积更小的 .json.gz 文件</small></span>
          <input type="checkbox" checked={gzipExport} onChange={(e) => setGzipExport(e.target.checked)} />
        </label>
        <button className="market-cache-secondary-action" onClick={handleExportCache}>
          <Download size={16} />
          导出行情缓存
        </button>

        {importStatus === 'ERROR' && errorMessage && <div className="market-cache-inline-status is-error"><XCircle size={16} aria-hidden="true" /><span>{errorMessage}</span></div>}
        {importStatus === 'SUCCESS' && importReport && (
          <div className="market-cache-inline-status is-success">
            <div className="market-cache-report-heading"><CheckCircle size={16} aria-hidden="true" /><strong>导入成功</strong></div>
            <div className="market-cache-report-grid">
              <span>文件总数 {importReport.totalInFile}</span><span>有效 {importReport.valid}</span><span>无效 {importReport.invalid}</span>
              <span>已插入 {importReport.inserted}</span><span>已跳过 {importReport.skipped}</span><span>已覆盖 {importReport.overwritten}</span>
            </div>
            {importReport.invalidDetails.length > 0 && <div className="market-cache-report-details">校验失败：{importReport.invalidDetails.slice(0, 3).map((d) => `第${d.row + 1}行 ${d.reason}`).join('；')}</div>}
            {importReport.overwrittenDetails.length > 0 && <div className="market-cache-report-details">已覆盖 {importReport.overwrittenDetails.length} 条原有数据，最近更新时间：{formatDate(importReport.overwrittenDetails[0].oldFetchedAt)}</div>}
          </div>
        )}
      </section>
    </div>
  );
}
