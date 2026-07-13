import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/localDb';
import { backupService, BackupPreview } from '../core/backup/backupService';
import { TradeType } from '../db/schema';
import {
  Download,
  Upload,
  AlertTriangle,
  FileText,
  CheckCircle,
  LoaderCircle,
  History,
  Calendar,
  Layers,
  Database,
  XCircle,
  Inbox,
} from 'lucide-react';
import { TradeTypeLabels } from '../shared/models';
import { isAndroidNativeRuntime } from '../platform/nativeRuntime';
import { useAppShell } from '../app/AppShell';
import { SecondaryPageHeader } from '../components/SecondaryPageHeader';
import { parsePdfStatementText, type ParsedTradeCandidate } from '@recoder/core';
import { extractPdfText } from '../core/imports/pdfTextExtractor';
import {
  dismissNativeInboxItem,
  finalizeNativeInboxItem,
  importParsedCandidate,
  importNativeInboxCandidate,
  listNativeInboxPreviews,
  type NativeInboxPreview,
} from '../core/imports/nativeInboxService';

export default function ImportExportPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<BackupPreview | null>(null);
  const [importStatus, setImportStatus] = useState<'IDLE' | 'SUCCESS' | 'ERROR'>('IDLE');
  const [isImporting, setIsImporting] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const importInFlightRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState('');
  const [nativePreviews, setNativePreviews] = useState<NativeInboxPreview[]>([]);
  const [nativeInboxBusy, setNativeInboxBusy] = useState(false);
  const [nativeInboxMessage, setNativeInboxMessage] = useState('');
  const [pdfPasswords, setPdfPasswords] = useState<Record<string, string>>({});
  const [statementFile, setStatementFile] = useState<File | null>(null);
  const [statementPassword, setStatementPassword] = useState('');
  const [statementCandidates, setStatementCandidates] = useState<ParsedTradeCandidate[]>([]);
  const [statementWarnings, setStatementWarnings] = useState<string[]>([]);
  const [statementBusy, setStatementBusy] = useState(false);
  const [statementMessage, setStatementMessage] = useState('');
  const isAndroid = isAndroidNativeRuntime();
  const { activePlatform } = useAppShell();

  useEffect(() => {
    if (isAndroid || !activePlatform) return;
    void db.appSettings.get(`statement_pdf_password_${activePlatform}`).then((setting) => {
      if (typeof setting?.value === 'string') setStatementPassword(setting.value);
    });
  }, [activePlatform, isAndroid]);

  const refreshNativeInbox = async (passwords = pdfPasswords) => {
    if (!isAndroid) return;
    setNativeInboxBusy(true);
    try {
      setNativePreviews(await listNativeInboxPreviews(passwords));
    } catch (error) {
      setNativeInboxMessage(`读取 Android 待导入收件箱失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setNativeInboxBusy(false);
    }
  };

  useEffect(() => {
    void refreshNativeInbox();
  // Native runtime detection is stable for the lifetime of the app.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImportNativeItem = async (preview: NativeInboxPreview) => {
    if (preview.candidates.length === 0) return;
    setNativeInboxBusy(true);
    try {
      const results = [];
      for (const candidate of preview.candidates) {
        results.push(await importNativeInboxCandidate(preview.item, candidate));
      }
      await finalizeNativeInboxItem(preview.item, results);
      setNativeInboxMessage(results.map((result) => result.message).join('；'));
      await refreshNativeInbox();
    } catch (error) {
      setNativeInboxMessage(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setNativeInboxBusy(false);
    }
  };

  const handleDismissNativeItem = async (preview: NativeInboxPreview) => {
    setNativeInboxBusy(true);
    try {
      await dismissNativeInboxItem(preview.item);
      setNativeInboxMessage('已跳过该待导入内容，未写入账本。');
      await refreshNativeInbox();
    } catch (error) {
      setNativeInboxMessage(`操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setNativeInboxBusy(false);
    }
  };

  const previewStatementFile = async (file: File, password = '') => {
    setStatementBusy(true);
    setStatementMessage('');
    try {
      const text = await extractPdfText(file, password);
      const parsed = parsePdfStatementText(text);
      setStatementCandidates(parsed.candidates);
      setStatementWarnings(parsed.warnings);
    } catch (error) {
      setStatementCandidates([]);
      setStatementWarnings([error instanceof Error ? error.message : String(error)]);
    } finally {
      setStatementBusy(false);
    }
  };

  const handleStatementFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatementFile(file);
    void previewStatementFile(file, statementPassword);
  };

  const handleImportStatement = async () => {
    if (statementCandidates.length === 0) return;
    setStatementBusy(true);
    try {
      const results = [];
      for (const candidate of statementCandidates) {
        results.push(await importParsedCandidate(candidate, `Web PDF 结单 ${statementFile?.name ?? ''}`));
      }
      setStatementMessage(results.map((result) => result.message).join('；'));
      if (!results.some((result) => result.status === 'FAILED')) {
        setStatementCandidates([]);
      }
    } catch (error) {
      setStatementMessage(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setStatementBusy(false);
    }
  };

  // Fetch import history reactive query
  const importHistory = useLiveQuery(async () => {
    if (!db.backupImportRecords) return [];
    return db.backupImportRecords.orderBy('importedAt').reverse().toArray();
  }) ?? [];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setSelectedFile(file);
      
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const content = event.target?.result as string;
          const preview = backupService.parseBackup(content);
          setPreviewData(preview);
          setImportStatus('IDLE');
          setImportMessage('');
          setErrorMessage('');
        } catch (err: any) {
          setErrorMessage(err.message || '解析备份文件失败，请确保是标准的 JSON 格式文件！');
          setImportStatus('ERROR');
          setSelectedFile(null);
          setPreviewData(null);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleExport = async () => {
    try {
      const backup = await backupService.exportBackup();
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      const dateStr = new Date().toISOString().split('T')[0];
      downloadAnchor.setAttribute("download", `stockledger_backup_${dateStr}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    } catch (err: any) {
      alert(`导出备份失败: ${err.message || err}`);
    }
  };

  const handleImport = async (mode: 'APPEND' | 'OVERWRITE') => {
    if (!previewData || !selectedFile) return;

    if (mode === 'OVERWRITE' && !showOverwriteConfirm) {
      setShowOverwriteConfirm(true);
      return;
    }

    // The ref becomes true synchronously, before React has a chance to render
    // disabled controls, so rapid taps cannot start duplicate imports.
    if (importInFlightRef.current) return;

    importInFlightRef.current = true;
    setIsImporting(true);
    setImportStatus('IDLE');
    setImportMessage('正在写入账本和流水，请勿重复点击或关闭应用。');
    try {
      const result = await backupService.importBackup(previewData.rawParsedData, mode, selectedFile.name);
      setImportStatus('SUCCESS');
      setImportMessage(`导入完成：新增 ${result.transactionCount} 笔，重复 ${result.duplicateCount} 笔，冲突 ${result.conflictCount} 笔。已切换至导入账本。`);
      setPreviewData(null);
      setSelectedFile(null);
      setShowOverwriteConfirm(false);
      setTypedConfirm('');
      setErrorMessage('');
    } catch (err: any) {
      setErrorMessage(err.message || '导入数据失败，请检查文件内容。');
      setImportStatus('ERROR');
      setShowOverwriteConfirm(false);
      setTypedConfirm('');
    } finally {
      importInFlightRef.current = false;
      setIsImporting(false);
    }
  };

  const formatDate = (timestamp: number) => {
    const dt = new Date(timestamp);
    return `${dt.getFullYear()}-${(dt.getMonth() + 1).toString().padStart(2, '0')}-${dt.getDate().toString().padStart(2, '0')} ${dt.getHours().toString().padStart(2, '0')}:${dt.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="page page-secondary">
      {/* Header */}
      <SecondaryPageHeader title={location.pathname.endsWith('/backup') ? '备份与迁移' : '邮件与结单导入'} fallback="/data" />

      {isAndroid && (
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Inbox size={18} style={{ color: 'var(--accent)' }} />
            <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Android 待导入收件箱</h3>
            <button type="button" onClick={() => void refreshNativeInbox()} disabled={nativeInboxBusy} style={{ marginLeft: 'auto', padding: '0.3rem 0.55rem', fontSize: '0.75rem' }}>
              刷新
            </button>
          </div>
          <p className="text-xs text-muted" style={{ margin: 0 }}>
            来自“分享至 Recoder”的文本或 PDF 会先停在这里。仅解析文本型结单；确认后才会写入账本，重复与冲突不会被静默覆盖。
          </p>
          {nativeInboxMessage && <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{nativeInboxMessage}</div>}
          {nativePreviews.length === 0 ? (
            <div className="text-xs text-muted" style={{ textAlign: 'center', padding: '0.5rem 0' }}>
              {nativeInboxBusy ? '正在读取…' : '暂无待确认的导入内容'}
            </div>
          ) : nativePreviews.map((preview) => (
            <div key={preview.item.id} style={{ padding: '0.65rem', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div className="flex-between" style={{ gap: '0.5rem' }}>
                <strong style={{ fontSize: '0.8rem' }}>{preview.item.source === 'PDF' ? 'PDF 文本结单' : '分享文本 / 邮件'}</strong>
                <span className="text-xs text-muted">{formatDate(preview.item.receivedAt)}</span>
              </div>
              {preview.candidates.length > 0 ? preview.candidates.map((candidate) => (
                <div key={candidate.id} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {candidate.platform} · {TradeTypeLabels[candidate.tradeType as TradeType] ?? candidate.tradeType} {candidate.symbol} {candidate.quantity} 股 @ {candidate.price} · {candidate.tradeDate}
                </div>
              )) : <div className="text-xs" style={{ color: 'var(--color-warning)' }}>{preview.warnings.join(' ')}</div>}
              {preview.candidates.length > 0 && preview.warnings.length > 0 && <div className="text-xs" style={{ color: 'var(--color-warning)' }}>{preview.warnings.join(' ')}</div>}
              {preview.item.source === 'PDF' && preview.candidates.length === 0 && (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type="password"
                    value={pdfPasswords[preview.item.id] ?? ''}
                    onChange={(event) => setPdfPasswords({ ...pdfPasswords, [preview.item.id]: event.target.value })}
                    placeholder="如 PDF 已加密，请输入密码（仅本次提取使用）"
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.55rem' }}
                  />
                  <button type="button" disabled={nativeInboxBusy || !pdfPasswords[preview.item.id]} onClick={() => void refreshNativeInbox(pdfPasswords)} style={{ padding: '0.4rem 0.55rem', fontSize: '0.75rem' }}>重新提取</button>
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {preview.candidates.length > 0 && <button type="button" className="primary" disabled={nativeInboxBusy} onClick={() => void handleImportNativeItem(preview)} style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}>确认导入 {preview.candidates.length} 笔</button>}
                <button type="button" disabled={nativeInboxBusy} onClick={() => void handleDismissNativeItem(preview)} style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}>跳过</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileText size={18} style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>导入文本 PDF 结单</h3>
        </div>
        <p className="text-xs text-muted" style={{ margin: 0 }}>
          支持长桥、汇丰、uSMART 与嘉信的可复制文本结单。PDF、密码和提取文本只在本次浏览器会话中使用；扫描件不支持。
        </p>
        <input aria-label="选择 PDF 结单" type="file" accept="application/pdf,.pdf" onChange={handleStatementFileChange} disabled={statementBusy} />
        {statementFile && (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="password"
              value={statementPassword}
              onChange={(event) => setStatementPassword(event.target.value)}
              placeholder="如 PDF 已加密，请输入密码（不保存）"
              style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.55rem' }}
            />
            <button type="button" disabled={statementBusy || !statementPassword} onClick={() => void previewStatementFile(statementFile, statementPassword)} style={{ padding: '0.4rem 0.55rem', fontSize: '0.75rem' }}>重新解析</button>
          </div>
        )}
        {statementBusy && <div className="text-xs text-muted">正在提取并解析结单…</div>}
        {statementWarnings.length > 0 && <div className="text-xs" style={{ color: 'var(--color-warning)' }}>{statementWarnings.join(' ')}</div>}
        {statementMessage && <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{statementMessage}</div>}
        {statementCandidates.length > 0 && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {statementCandidates.map((candidate) => (
                <div key={candidate.id} className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {candidate.platform} · {TradeTypeLabels[candidate.tradeType as TradeType] ?? candidate.tradeType} {candidate.symbol} {candidate.quantity} 股 @ {candidate.price} · {candidate.tradeDate}
                </div>
              ))}
            </div>
            <button type="button" className="primary" disabled={statementBusy} onClick={() => void handleImportStatement()}>
              确认导入 {statementCandidates.length} 笔
            </button>
          </>
        )}
      </div>

      {/* Export Section */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Download size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>导出本地备份</h3>
        </div>
        <p className="text-sm text-muted">
          将所有交易明细、账本及货币等配置打包导出为一个加密安全的 JSON 文件，以保存在本地或转移到其他设备上。
        </p>
        
        <button className="primary" onClick={handleExport} style={{ marginTop: '0.25rem', width: '100%' }}>
          <Download size={16} />
          下载备份 JSON
        </button>
      </div>

      {/* Import Section */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Upload size={18} className="text-accent" style={{ color: 'var(--accent)' }} />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>导入外部备份</h3>
        </div>
        <p className="text-sm text-muted">
          选择本应用或原 Android 客户端导出的 JSON 备份文件。
        </p>

        {/* Drag and Drop Box */}
        <div style={{
          border: '2px dashed var(--border-color)',
          borderRadius: '10px',
          padding: '1.75rem 1rem',
          textAlign: 'center',
          backgroundColor: 'rgba(31, 41, 55, 0.15)',
          cursor: 'pointer',
          position: 'relative',
          transition: 'all 0.2s ease',
        }}
        className="list-item-hover"
        >
          <Upload size={28} style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }} />
          <div className="text-sm" style={{ fontWeight: 600 }}>
            {selectedFile ? '已选择文件' : '点击此处选择备份文件'}
          </div>
          <div className="text-xs text-muted" style={{ marginTop: '0.25rem' }}>
            {selectedFile ? selectedFile.name : '支持 *.json 格式文件'}
          </div>
          <input 
            type="file" 
            accept=".json"
            onChange={handleFileChange}
            disabled={isImporting}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', opacity: 0, cursor: isImporting ? 'not-allowed' : 'pointer' }}
          />
        </div>

        {isImporting && (
          <div role="status" aria-live="polite" style={{ padding: '0.75rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.8rem' }}>
            <LoaderCircle size={16} className="spin" style={{ flexShrink: 0, color: 'var(--accent)' }} />
            <div>{importMessage}</div>
          </div>
        )}

        {/* Error Alert */}
        {importStatus === 'ERROR' && errorMessage && (
          <div style={{ padding: '0.75rem', backgroundColor: 'var(--color-error-bg)', border: '1px solid var(--color-error-border)', borderRadius: '8px', display: 'flex', gap: '0.5rem', color: '#fca5a5', fontSize: '0.8rem' }}>
            <XCircle size={16} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
            <div>{errorMessage}</div>
          </div>
        )}

        {/* Success Alert */}
        {importStatus === 'SUCCESS' && (
          <div style={{ padding: '0.75rem', backgroundColor: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)', borderRadius: '8px', display: 'flex', gap: '0.5rem', color: '#a7f3d0', fontSize: '0.8rem', alignItems: 'center' }}>
            <CheckCircle size={16} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1 }}>{importMessage || '数据备份恢复成功！对应的账本与流水已刷新。'}</div>
            <button type="button" onClick={() => navigate('/')} style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>查看持仓</button>
          </div>
        )}

        {/* Preview Data Dashboard */}
        {previewData && (
          <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }} />
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>备份文件解析预览:</div>
            
            {/* Stat Cards Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
              <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  <Database size={12} />
                  <span>版本 / 币种</span>
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, marginTop: '0.15rem' }}>
                  v{previewData.version} / {previewData.displayCurrency}
                </div>
              </div>

              <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  <Layers size={12} />
                  <span>账本数量</span>
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, marginTop: '0.15rem' }}>
                  {previewData.ledgersCount} 个
                </div>
              </div>

              <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  <FileText size={12} />
                  <span>交易记录</span>
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, marginTop: '0.15rem' }}>
                  {previewData.transactionsCount} 笔
                </div>
              </div>

              <div style={{ padding: '0.5rem 0.75rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  <Calendar size={12} />
                  <span>时间跨度</span>
                </div>
                <div style={{ fontSize: '0.75rem', fontWeight: 600, marginTop: '0.3rem', wordBreak: 'break-all' }}>
                  {previewData.dateRange}
                </div>
              </div>
            </div>

            {/* Breakdown List */}
            {Object.keys(previewData.tradeTypeBreakdown).length > 0 && (
              <div style={{ padding: '0.65rem 0.75rem', backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px dashed var(--border-color)' }}>
                <div className="text-xs text-muted" style={{ marginBottom: '0.4rem', fontWeight: 600 }}>交易类型构成:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                  {Object.entries(previewData.tradeTypeBreakdown).map(([type, count]) => (
                    <span 
                      key={type} 
                      className={`badge`} 
                      style={{ 
                        fontSize: '0.7rem', 
                        backgroundColor: 'var(--bg-input)', 
                        borderColor: 'var(--border-color)',
                        color: 'var(--text-primary)',
                        padding: '0.15rem 0.4rem'
                      }}
                    >
                      {TradeTypeLabels[type as TradeType] || type}: {count}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Data list preview */}
            {previewData.previewTransactions.length > 0 && (
              <div>
                <div className="text-xs text-muted" style={{ marginBottom: '0.4rem', fontWeight: 600 }}>最近交易预览:</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {previewData.previewTransactions.map((tx, idx) => {
                    const isBuy = tx.tradeType === 'BUY' || tx.tradeType === 'DEPOSIT';
                    return (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.45rem 0.6rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.75rem' }}>
                        <div>
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)', marginRight: '0.4rem' }}>
                            {tx.symbol}
                          </span>
                          <span className={`badge ${isBuy ? 'success' : 'error'}`} style={{ fontSize: '0.65rem', padding: '0.05rem 0.25rem' }}>
                            {TradeTypeLabels[tx.tradeType as TradeType] || tx.tradeType}
                          </span>
                        </div>
                        <div style={{ color: 'var(--text-muted)' }}>
                          {tx.tradeDate} | {tx.quantity} 股 @ {tx.price.toFixed(2)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Buttons for Append / Overwrite */}
            {importStatus === 'IDLE' && !showOverwriteConfirm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button 
                    onClick={() => handleImport('APPEND')}
                    disabled={isImporting}
                    style={{ flex: 1, backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-color)' }}
                  >
                    追加导入
                  </button>
                  <button 
                    onClick={() => handleImport('OVERWRITE')}
                    disabled={isImporting}
                    className="danger"
                    style={{ flex: 1 }}
                  >
                    清空覆盖导入
                  </button>
                </div>
                <div style={{ display: 'flex', gap: '0.25rem', color: 'var(--color-warning)', fontSize: '0.7rem', marginTop: '0.2rem' }}>
                  <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: '0.05rem' }} />
                  <span>温馨提示：“追加导入”会将新交易追加在后面；而“清空覆盖”将抹除浏览器当前全部记录，导入备份中的全部数据。</span>
                </div>
              </div>
            )}

            {/* Overwrite Confirmation box */}
            {showOverwriteConfirm && (
              <div style={{ 
                padding: '0.75rem', 
                backgroundColor: 'rgba(239, 68, 68, 0.1)', 
                border: '1px solid var(--color-error-border)', 
                borderRadius: '8px', 
                display: 'flex', 
                flexDirection: 'column', 
                gap: '0.5rem',
                animation: 'pulse 2s infinite'
              }}>
                <div style={{ display: 'flex', gap: '0.25rem', color: '#f87171', fontSize: '0.75rem', fontWeight: 700 }}>
                  <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                  <span>高危操作：您正在执行“清空并覆盖导入”</span>
                </div>
                <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  这会永久清除本地的所有已有账本、流水、行情缓存。为确认操作，请在下方输入框中手动键入大写的 <strong style={{ color: '#ef4444' }}>OVERWRITE</strong> 以解锁该导入。
                </p>
                <input 
                  type="text" 
                  value={typedConfirm}
                  onChange={(e) => setTypedConfirm(e.target.value)}
                  placeholder="请输入 OVERWRITE"
                  style={{ fontSize: '0.8rem', padding: '0.4rem 0.6rem', border: '1px solid var(--color-error-border)' }}
                />
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <button 
                    disabled={typedConfirm !== 'OVERWRITE' || isImporting}
                    onClick={() => handleImport('OVERWRITE')}
                    className="danger" 
                    style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}
                  >
                    解锁并执行覆盖
                  </button>
                  <button 
                    disabled={isImporting}
                    onClick={() => { setShowOverwriteConfirm(false); setTypedConfirm(''); }}
                    style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* History log Section */}
      <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <History size={18} className="text-muted" />
          <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>导入历史审计</h3>
        </div>
        
        {importHistory.length === 0 ? (
          <div className="text-xs text-muted" style={{ textAlign: 'center', padding: '1rem 0' }}>
            暂无历史数据恢复记录
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '180px', overflowY: 'auto', paddingRight: '0.25rem' }}>
            {importHistory.map((record) => {
              const isSuccess = record.status === 'SUCCESS';
              return (
                <div key={record.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', fontSize: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '240px' }} title={record.fileName}>
                      {record.fileName}
                    </div>
                    <span className={`badge ${isSuccess ? 'success' : 'error'}`} style={{ fontSize: '0.65rem', padding: '0.05rem 0.3rem' }}>
                      {isSuccess ? '成功' : '失败'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                    <span>导入时间: {formatDate(record.importedAt)}</span>
                    {isSuccess && (
                      <span>数据: {record.ledgerCount}L / {record.transactionCount}T</span>
                    )}
                  </div>
                  {!isSuccess && record.message && (
                    <div style={{ color: '#fca5a5', fontSize: '0.65rem', marginTop: '0.1rem', wordBreak: 'break-all' }}>
                      错误: {record.message}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
