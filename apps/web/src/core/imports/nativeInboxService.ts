import { createSyncId, createTransactionFingerprint, importedTradeTimestamp, parseBrokerText, parsePdfStatementText, type ParsedTradeCandidate } from '@recoder/core';
import Dexie from 'dexie';
import { db } from '../../db/localDb';
import type { Transaction } from '../../db/schema';
import { isAndroidNativeRuntime, nativeDocument, nativeInbox, nativeSecretKeyForStatement, type NativeInboxItem } from '../../platform/nativeRuntime';

export interface NativeInboxPreview {
  item: NativeInboxItem;
  candidates: ParsedTradeCandidate[];
  warnings: string[];
}

export interface NativeInboxImportResult {
  status: 'IMPORTED' | 'DUPLICATE' | 'FAILED';
  message: string;
}

/** Shared confirmation-to-ledger path for Android inbox and Web PDF imports. */
export async function importParsedCandidate(
  candidate: ParsedTradeCandidate,
  sourceLabel: string,
): Promise<NativeInboxImportResult> {
  // Web Crypto is not an IndexedDB request.  Await it before opening the
  // Dexie transaction, otherwise the browser may auto-commit the transaction
  // while SHA-256 is being calculated (Transaction committed too early).
  const candidateRecord = {
    platform: candidate.platform,
    externalReference: candidate.externalReference,
    tradeType: candidate.tradeType,
    market: candidate.market,
    symbol: candidate.symbol,
    tradeDate: candidate.tradeDate,
    tradeTime: candidate.tradeTime,
    price: candidate.price,
    quantity: candidate.quantity,
    commission: candidate.commission,
    tax: candidate.tax,
    assetType: 'STOCK',
  };
  const fingerprint = await createTransactionFingerprint(candidateRecord);

  const result = await db.transaction('rw', [db.transactions, db.appSettings], async () => {
    const defaultLedger = await db.appSettings.get('default_ledger');
    const ledgerId = typeof defaultLedger?.value === 'number' ? defaultLedger.value : 1;
    const transactions = await db.transactions.toArray();
    const sameReference = transactions.find((transaction) =>
      transaction.platform === candidate.platform && transaction.externalReference === candidate.externalReference,
    );
    const sameFingerprint = transactions.find((transaction) => transaction.sourceFingerprint === fingerprint);
    const existing = sameReference ?? sameFingerprint;
    if (existing) {
      // Legacy rows can lack a persisted fingerprint. Keep this exceptional
      // crypto operation within the transaction explicitly alive.
      const existingFingerprint = existing.sourceFingerprint
        ?? await Dexie.waitFor(createTransactionFingerprint(existing as unknown as Record<string, unknown>));
      if (existingFingerprint === fingerprint) {
        return { status: 'DUPLICATE' as const, message: `已忽略重复交易：${candidate.symbol} ${candidate.tradeDate}` };
      }
      return { status: 'FAILED' as const, message: `检测到外部编号冲突：${candidate.externalReference}。原始内容未覆盖本地交易。` };
    }
    const now = Date.now();
    const createdAt = importedTradeTimestamp(candidate.tradeDate, candidate.tradeTime) ?? now;
    await db.transactions.add({
      syncId: createSyncId(),
      sourceFingerprint: fingerprint,
      ledgerId,
      tradeType: candidate.tradeType,
      platform: candidate.platform,
      sourceChannel: candidate.sourceChannel,
      externalReference: candidate.externalReference,
      market: candidate.market,
      symbol: candidate.symbol,
      name: candidate.name,
      tradeDate: candidate.tradeDate,
      tradeTime: candidate.tradeTime,
      price: candidate.price,
      quantity: candidate.quantity,
      commission: candidate.commission,
      tax: candidate.tax,
      note: sourceLabel,
      createdAt,
      updatedAt: now,
      investorName: null,
      assetType: 'STOCK',
      underlyingSymbol: null,
      expiryDate: null,
      strikePrice: null,
      optionType: null,
      contractKey: null,
      occSymbol: null,
      fxFromCurrency: null,
      fxFromAmount: null,
      fxToCurrency: null,
      fxToAmount: null,
      fxRate: null,
    } as Transaction);
    return { status: 'IMPORTED' as const, message: `已导入 ${candidate.symbol} ${candidate.tradeDate}` };
  });
  return result;
}

const asObject = (raw: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return { text: raw };
  }
};

async function inboxText(item: NativeInboxItem, password?: string): Promise<{ text: string; warnings: string[] }> {
  const payload = asObject(item.payload);
  if (item.source === 'PDF') {
    const path = typeof payload.path === 'string' ? payload.path : '';
    if (!path) return { text: '', warnings: ['PDF 待导入项缺少文件路径。'] };
    try {
      const response = await nativeDocument.extractPdfText({
        path,
        password: password || undefined,
        passwordKey: password ? undefined : nativeSecretKeyForStatement(item.platform),
      });
      return response.isEmpty
        ? { text: '', warnings: ['未从 PDF 提取到文本。扫描件不受支持，请使用可复制文本的电子结单。'] }
        : { text: response.text, warnings: [] };
    } catch (error) {
      return { text: '', warnings: [`PDF 文本提取失败：${error instanceof Error ? error.message : String(error)}`] };
    }
  }
  const text = typeof payload.text === 'string'
    ? payload.text
    : typeof payload.rawText === 'string'
      ? payload.rawText
      : item.payload;
  return text.trim() ? { text, warnings: [] } : { text: '', warnings: ['待导入内容为空。'] };
}

export async function listNativeInboxPreviews(pdfPasswords: Record<string, string> = {}): Promise<NativeInboxPreview[]> {
  if (!isAndroidNativeRuntime()) return [];
  const { items } = await nativeInbox.listPending();
  return Promise.all(items.map(async (item) => {
    const extracted = await inboxText(item, pdfPasswords[item.id]);
    if (!extracted.text) return { item, candidates: [], warnings: extracted.warnings };
    const parsed = item.source === 'PDF' ? parsePdfStatementText(extracted.text) : parseBrokerText(extracted.text);
    return { item, candidates: parsed.candidates, warnings: [...extracted.warnings, ...parsed.warnings] };
  }));
}

/**
 * The only path from native inbox to IndexedDB. It always checks source
 * references and canonical fingerprints before writing, and preserves
 * conflicting input for review instead of overwriting local transactions.
 */
export async function importNativeInboxCandidate(
  item: NativeInboxItem,
  candidate: ParsedTradeCandidate,
): Promise<NativeInboxImportResult> {
  // Keep a candidate's own transaction reference (one mail can contain more
  // than one confirmation), while scoping it to the native mailbox ID.
  const payload = asObject(item.payload);
  const mailboxId = typeof payload.mailboxId === 'string' ? payload.mailboxId : '';
  return importParsedCandidate(
    { ...candidate, externalReference: mailboxId ? `${mailboxId}:${candidate.externalReference}` : candidate.externalReference },
    `原生收件箱 ${item.id}：${item.source}`,
  );
}

/** Finalize an inbox message only after every candidate was reviewed. */
export async function finalizeNativeInboxItem(
  item: NativeInboxItem,
  results: NativeInboxImportResult[],
): Promise<void> {
  if (!isAndroidNativeRuntime() || results.some((result) => result.status === 'FAILED')) return;
  const status = results.every((result) => result.status === 'DUPLICATE') ? 'DUPLICATE' : 'IMPORTED';
  await nativeInbox.markHandled({
    id: item.id,
    status,
    message: results.map((result) => result.message).join('；'),
  });
}

export async function dismissNativeInboxItem(item: NativeInboxItem): Promise<void> {
  if (!isAndroidNativeRuntime()) return;
  await nativeInbox.markHandled({ id: item.id, status: 'FAILED', message: '用户跳过，未写入账本。' });
}
