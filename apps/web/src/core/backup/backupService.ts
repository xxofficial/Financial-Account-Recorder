import {
  BACKUP_V5_FORMAT,
  BACKUP_V5_VERSION,
  backupV5Schema,
  parseSupportedBackup,
  type BackupV4,
  type BackupV5,
  type BackupV5Ledger,
  type BackupV5Transaction,
} from '@recoder/contracts';
import Dexie from 'dexie';
import { createSyncId, createTransactionFingerprint, sameTransactionContent } from '@recoder/core';
import { db } from '../../db/localDb';
import { marketCacheManager } from '../market/marketCacheManager';
import { MarketTaskExecutor } from '../market/MarketTaskExecutor';
import type { BackupImportRecord, Transaction } from '../../db/schema';

export interface LegacyBackupData {
  version?: number;
  displayCurrency?: string;
  enabledPlatforms?: string[];
  selectedPlatform?: string | null;
  ledgers: object[];
  transactions: object[];
  [key: string]: unknown;
}

export type BackupData = LegacyBackupData | BackupV5;
export type BackupImportMode = 'APPEND' | 'OVERWRITE';

export interface BackupPreview {
  version: number;
  sourceVersion: 4 | 5;
  displayCurrency: string;
  enabledPlatforms: string[];
  ledgersCount: number;
  transactionsCount: number;
  dateRange: string;
  tradeTypeBreakdown: Record<string, number>;
  previewTransactions: Array<{
    tradeType: string;
    symbol: string;
    tradeDate: string;
    quantity: number;
    price: number;
  }>;
  rawParsedData: BackupData;
}

export interface BackupImportResult {
  ledgerCount: number;
  transactionCount: number;
  duplicateCount: number;
  conflictCount: number;
}

type LooseRecord = Record<string, unknown>;

const now = () => Date.now();
const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const asNullableString = (value: unknown) => typeof value === 'string' && value.trim() ? value : null;
const asNumber = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const asOptionalId = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

function legacyLedgerSyncId(ledger: LooseRecord, index: number): string {
  const name = asString(ledger.name, `ledger-${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-');
  return `legacy-ledger-${asOptionalId(ledger.id) ?? index + 1}-${name || 'default'}-${asNumber(ledger.createdAt, 0)}`;
}

function normalizedDate(value: unknown): string {
  const date = asString(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '1970-01-01';
}

function normalizedTime(value: unknown): string {
  const time = asString(value);
  return /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '00:00:00';
}

async function upgradeV4Backup(backup: BackupV4): Promise<BackupV5> {
  const timestamp = now();
  const legacyLedgers = backup.ledgers.length > 0
    ? backup.ledgers
    : [{ id: 1, name: '默认个人账本', type: 'PERSONAL', description: '', partners: '', createdAt: timestamp, updatedAt: timestamp }];
  const ledgers = legacyLedgers.map((raw, index): BackupV5Ledger => ({
    syncId: legacyLedgerSyncId(raw, index),
    legacyId: asOptionalId(raw.id),
    name: asString(raw.name, '默认个人账本'),
    type: raw.type === 'JOINT' ? 'JOINT' : 'PERSONAL',
    description: asString(raw.description),
    partners: asString(raw.partners),
    createdAt: asNumber(raw.createdAt, timestamp),
    updatedAt: asNumber(raw.updatedAt, asNumber(raw.createdAt, timestamp)),
  }));
  const ledgerIds = new Map<number, string>();
  ledgers.forEach((ledger, index) => ledgerIds.set(ledger.legacyId ?? index + 1, ledger.syncId));
  const fallbackLedger = ledgers[0].syncId;

  const transactions: BackupV5Transaction[] = [];
  for (const raw of backup.transactions) {
    const base = {
      platform: asString(raw.platform, 'UNSPECIFIED'),
      externalReference: asNullableString(raw.externalReference),
      tradeType: asString(raw.tradeType, 'OTHER'),
      market: asString(raw.market, 'CASH'),
      symbol: asString(raw.symbol),
      tradeDate: normalizedDate(raw.tradeDate),
      tradeTime: normalizedTime(raw.tradeTime),
      price: asNumber(raw.price),
      quantity: asNumber(raw.quantity),
      commission: asNumber(raw.commission),
      tax: asNumber(raw.tax),
      assetType: asString(raw.assetType, 'STOCK'),
      contractKey: asNullableString(raw.contractKey),
      fxFromCurrency: asNullableString(raw.fxFromCurrency),
      fxFromAmount: raw.fxFromAmount ?? null,
      fxToCurrency: asNullableString(raw.fxToCurrency),
      fxToAmount: raw.fxToAmount ?? null,
      fxRate: raw.fxRate ?? null,
      transferGroupId: asNullableString(raw.transferGroupId),
      transferCounterpartyPlatform: asNullableString(raw.transferCounterpartyPlatform),
    };
    const fingerprint = await createTransactionFingerprint(base);
    const tradeType = ['BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT', 'TRANSFER_IN', 'INTEREST', 'SPLIT', 'EXPIRE', 'DIVIDEND', 'TAX', 'FX_CONVERSION', 'OTHER'].includes(base.tradeType)
      ? base.tradeType as BackupV5Transaction['tradeType']
      : 'OTHER';
    const market = ['A_SHARE', 'HK', 'US', 'CASH'].includes(base.market)
      ? base.market as BackupV5Transaction['market']
      : 'CASH';
    const assetType = base.assetType === 'OPTION' ? 'OPTION' : 'STOCK';
    transactions.push({
      syncId: asString(raw.syncId) || `legacy-${fingerprint}`,
      legacyId: asOptionalId(raw.id),
      ledgerSyncId: ledgerIds.get(asOptionalId(raw.ledgerId) ?? 1) ?? fallbackLedger,
      tradeType,
      platform: base.platform,
      sourceChannel: asNullableString(raw.sourceChannel),
      externalReference: base.externalReference,
      market,
      symbol: base.symbol,
      name: asString(raw.name, base.symbol),
      tradeDate: base.tradeDate,
      tradeTime: base.tradeTime,
      price: base.price,
      quantity: base.quantity,
      commission: base.commission,
      tax: base.tax,
      note: asString(raw.note),
      investorName: asNullableString(raw.investorName),
      assetType,
      underlyingSymbol: asNullableString(raw.underlyingSymbol),
      expiryDate: asNullableString(raw.expiryDate),
      strikePrice: typeof raw.strikePrice === 'number' ? raw.strikePrice : null,
      optionType: raw.optionType === 'CALL' || raw.optionType === 'PUT' ? raw.optionType : null,
      contractKey: base.contractKey,
      occSymbol: asNullableString(raw.occSymbol),
      fxFromCurrency: base.fxFromCurrency,
      fxFromAmount: typeof raw.fxFromAmount === 'number' ? raw.fxFromAmount : null,
      fxToCurrency: base.fxToCurrency,
      fxToAmount: typeof raw.fxToAmount === 'number' ? raw.fxToAmount : null,
      fxRate: typeof raw.fxRate === 'number' ? raw.fxRate : null,
      transferGroupId: base.transferGroupId,
      transferCounterpartyPlatform: base.transferCounterpartyPlatform,
      fingerprint,
      createdAt: asNumber(raw.createdAt, timestamp),
      updatedAt: asNumber(raw.updatedAt, asNumber(raw.createdAt, timestamp)),
    });
  }

  return backupV5Schema.parse({
    format: BACKUP_V5_FORMAT,
    version: BACKUP_V5_VERSION,
    generatedAt: timestamp,
    displayCurrency: backup.displayCurrency,
    enabledPlatforms: backup.enabledPlatforms,
    feePlanSelections: {},
    ledgers,
    transactions,
  });
}

async function toV5(backup: BackupData): Promise<BackupV5> {
  const parsed = parseSupportedBackup(backup);
  return parsed.kind === 'v5' ? parsed.value : upgradeV4Backup(parsed.value);
}

function previewFrom(backup: BackupData): BackupPreview {
  const parsed = parseSupportedBackup(backup);
  const rawTransactions = parsed.kind === 'v5' ? parsed.value.transactions : parsed.value.transactions;
  const breakdown: Record<string, number> = {};
  let minDate = '';
  let maxDate = '';
  for (const item of rawTransactions) {
    const type = asString(item.tradeType, 'OTHER');
    const date = asString(item.tradeDate);
    breakdown[type] = (breakdown[type] ?? 0) + 1;
    if (date && (!minDate || date < minDate)) minDate = date;
    if (date && (!maxDate || date > maxDate)) maxDate = date;
  }
  return {
    version: parsed.kind === 'v5' ? 5 : 4,
    sourceVersion: parsed.kind === 'v5' ? 5 : 4,
    displayCurrency: parsed.value.displayCurrency,
    enabledPlatforms: parsed.value.enabledPlatforms,
    ledgersCount: parsed.value.ledgers.length,
    transactionsCount: rawTransactions.length,
    dateRange: minDate ? `${minDate} ~ ${maxDate}` : '无交易数据',
    tradeTypeBreakdown: breakdown,
    previewTransactions: rawTransactions.slice(0, 5).map((item) => ({
      tradeType: asString(item.tradeType, 'OTHER'),
      symbol: asString(item.symbol, '-'),
      tradeDate: asString(item.tradeDate, '-'),
      quantity: asNumber(item.quantity),
      price: asNumber(item.price),
    })),
    rawParsedData: parsed.value,
  };
}

export class BackupService {
  async exportBackup(): Promise<BackupV5> {
    const timestamp = now();
    const ledgers = await db.ledgers.toArray();
    const ledgerSyncIds = new Map<number, string>();
    const backupLedgers: BackupV5Ledger[] = [];
    for (const ledger of ledgers) {
      const syncId = ledger.syncId ?? createSyncId();
      if (!ledger.syncId && ledger.id) await db.ledgers.update(ledger.id, { syncId });
      if (ledger.id) ledgerSyncIds.set(ledger.id, syncId);
      backupLedgers.push({
        syncId,
        legacyId: ledger.id,
        name: ledger.name,
        type: ledger.type,
        description: ledger.description,
        partners: ledger.partners,
        createdAt: ledger.createdAt,
        updatedAt: ledger.updatedAt,
      });
    }
    const fallbackLedger = backupLedgers[0]?.syncId ?? createSyncId();
    const transactions = await db.transactions.toArray();
    const backupTransactions: BackupV5Transaction[] = [];
    for (const tx of transactions) {
      const fingerprint = tx.sourceFingerprint ?? await createTransactionFingerprint(tx as unknown as LooseRecord);
      const syncId = tx.syncId ?? createSyncId();
      if (tx.id && (!tx.syncId || !tx.sourceFingerprint)) {
        await db.transactions.update(tx.id, { syncId, sourceFingerprint: fingerprint });
      }
      backupTransactions.push({
        syncId,
        legacyId: tx.id,
        ledgerSyncId: ledgerSyncIds.get(tx.ledgerId) ?? fallbackLedger,
        tradeType: tx.tradeType,
        platform: tx.platform,
        sourceChannel: tx.sourceChannel,
        externalReference: tx.externalReference,
        market: tx.market,
        symbol: tx.symbol,
        name: tx.name,
        tradeDate: tx.tradeDate,
        tradeTime: tx.tradeTime,
        price: tx.price,
        quantity: tx.quantity,
        commission: tx.commission,
        tax: tx.tax,
        note: tx.note,
        investorName: tx.investorName,
        assetType: tx.assetType,
        underlyingSymbol: tx.underlyingSymbol,
        expiryDate: tx.expiryDate,
        strikePrice: tx.strikePrice,
        optionType: tx.optionType,
        contractKey: tx.contractKey ?? null,
        occSymbol: tx.occSymbol ?? null,
        fxFromCurrency: tx.fxFromCurrency,
        fxFromAmount: tx.fxFromAmount,
        fxToCurrency: tx.fxToCurrency,
        fxToAmount: tx.fxToAmount,
        fxRate: tx.fxRate,
        transferGroupId: tx.transferGroupId ?? null,
        transferCounterpartyPlatform: tx.transferCounterpartyPlatform ?? null,
        fingerprint,
        createdAt: tx.createdAt,
        updatedAt: tx.updatedAt,
      });
    }
    const displayCurrency = (await db.appSettings.get('display_currency'))?.value ?? 'CNY';
    const enabledPlatforms = (await db.appSettings.get('enabled_platforms'))?.value ?? [];
    const feePlanSelections = (await db.appSettings.get('platform_fee_plan_selections'))?.value ?? {};
    const zhuoruiPromoConfig = (await db.appSettings.get('zhuorui_promo_config'))?.value;
    return backupV5Schema.parse({
      format: BACKUP_V5_FORMAT,
      version: BACKUP_V5_VERSION,
      generatedAt: timestamp,
      displayCurrency,
      enabledPlatforms,
      feePlanSelections,
      zhuoruiPromoConfig,
      ledgers: backupLedgers,
      transactions: backupTransactions,
    });
  }

  parseBackup(jsonString: string): BackupPreview {
    let raw: unknown;
    try { raw = JSON.parse(jsonString); } catch { throw new Error('解析 JSON 失败，文件格式不正确。'); }
    return previewFrom(raw as BackupData);
  }

  async importBackup(backup: BackupData, mode: BackupImportMode, fileName: string): Promise<BackupImportResult> {
    const incoming = await toV5(backup);
    let ledgerCount = 0;
    let transactionCount = 0;
    let duplicateCount = 0;
    let conflictCount = 0;
    let firstImportedTransactionLedgerId: number | undefined;
    const dates = incoming.transactions.map((tx) => tx.tradeDate).filter(Boolean).sort();
    await db.transaction('rw', [db.ledgers, db.transactions, db.appSettings, db.backupImportRecords], async () => {
      if (mode === 'OVERWRITE') {
        await db.ledgers.clear();
        await db.transactions.clear();
      }

      const ledgerIdBySyncId = new Map<string, number>();
      const localLedgers = await db.ledgers.toArray();
      for (const incomingLedger of incoming.ledgers) {
        const matched = localLedgers.find((ledger) => ledger.syncId === incomingLedger.syncId) ??
          localLedgers.find((ledger) => ledger.name === incomingLedger.name);
        if (matched?.id) {
          ledgerIdBySyncId.set(incomingLedger.syncId, matched.id);
          continue;
        }
        const id = await db.ledgers.add({
          syncId: incomingLedger.syncId,
          name: incomingLedger.name,
          type: incomingLedger.type,
          description: incomingLedger.description,
          partners: incomingLedger.partners,
          createdAt: incomingLedger.createdAt,
          updatedAt: incomingLedger.updatedAt,
        });
        ledgerIdBySyncId.set(incomingLedger.syncId, id);
        ledgerCount++;
      }
      const fallbackLedgerId = ledgerIdBySyncId.get(incoming.ledgers[0]?.syncId) ?? (await db.ledgers.toArray())[0]?.id ?? 1;
      const existing = await db.transactions.toArray();
      for (const tx of incoming.transactions) {
        // Treat fingerprints in a backup as an optimisation hint, never as
        // authority. Recompute from the payload so edited/corrupt v5 files
        // cannot turn a same-UUID content conflict into a false duplicate.
        const effectiveFingerprint = await Dexie.waitFor(createTransactionFingerprint(tx as unknown as LooseRecord));
        const normalizedIncoming = { ...tx, fingerprint: effectiveFingerprint };
        const sameSync = existing.find((item) => item.syncId === tx.syncId);
        const sameReference = tx.externalReference && existing.find((item) => item.platform === tx.platform && item.externalReference === tx.externalReference);
        if (sameSync) {
          const localFingerprint = sameSync.sourceFingerprint ?? await Dexie.waitFor(createTransactionFingerprint(sameSync as unknown as LooseRecord));
          const action = sameTransactionContent({ fingerprint: localFingerprint, updatedAt: sameSync.updatedAt }, normalizedIncoming);
          if (action === 'same') duplicateCount++;
          else conflictCount++;
          continue;
        }
        if (sameReference || existing.some((item) => item.sourceFingerprint === effectiveFingerprint)) {
          duplicateCount++;
          continue;
        }
        const localLedgerId = ledgerIdBySyncId.get(tx.ledgerSyncId) ?? fallbackLedgerId;
        const local: Transaction = {
          syncId: tx.syncId,
          sourceFingerprint: effectiveFingerprint,
          ledgerId: localLedgerId,
          tradeType: tx.tradeType,
          platform: tx.platform,
          sourceChannel: tx.sourceChannel,
          externalReference: tx.externalReference,
          market: tx.market,
          symbol: tx.symbol,
          name: tx.name,
          tradeDate: tx.tradeDate,
          tradeTime: tx.tradeTime,
          price: tx.price,
          quantity: tx.quantity,
          commission: tx.commission,
          tax: tx.tax,
          note: tx.note,
          createdAt: tx.createdAt,
          updatedAt: tx.updatedAt,
          investorName: tx.investorName,
          assetType: tx.assetType,
          underlyingSymbol: tx.underlyingSymbol,
          expiryDate: tx.expiryDate,
          strikePrice: tx.strikePrice,
          optionType: tx.optionType,
          contractKey: tx.contractKey,
          occSymbol: tx.occSymbol,
          fxFromCurrency: tx.fxFromCurrency,
          fxFromAmount: tx.fxFromAmount,
          fxToCurrency: tx.fxToCurrency,
          fxToAmount: tx.fxToAmount,
          fxRate: tx.fxRate,
          transferGroupId: tx.transferGroupId ?? null,
          transferCounterpartyPlatform: tx.transferCounterpartyPlatform ?? null,
        };
        await db.transactions.add(local);
        existing.push(local);
        transactionCount++;
        firstImportedTransactionLedgerId ??= localLedgerId;
      }
      if (mode === 'OVERWRITE') {
        await db.appSettings.put({ key: 'display_currency', value: incoming.displayCurrency, updatedAt: now() });
        await db.appSettings.put({ key: 'enabled_platforms', value: incoming.enabledPlatforms, updatedAt: now() });
        await db.appSettings.put({ key: 'platform_fee_plan_selections', value: incoming.feePlanSelections, updatedAt: now() });
        if (incoming.zhuoruiPromoConfig) await db.appSettings.put({ key: 'zhuorui_promo_config', value: incoming.zhuoruiPromoConfig, updatedAt: now() });
      }

      // A restored backup can receive different auto-incremented ledger IDs after
      // an overwrite. Keep the selected ledger pointing at imported data so the
      // portfolio and transaction pages do not filter against a deleted ledger.
      if (mode === 'OVERWRITE' || transactionCount > 0) {
        await db.appSettings.put({ key: 'default_ledger', value: firstImportedTransactionLedgerId ?? fallbackLedgerId, updatedAt: now() });
      }

      await db.backupImportRecords.add({
        fileName,
        importedAt: now(),
        transactionCount,
        ledgerCount,
        dateRangeStart: dates[0] ?? 'N/A',
        dateRangeEnd: dates.at(-1) ?? 'N/A',
        status: 'SUCCESS',
        message: `导入完成：新增 ${transactionCount} 笔，重复 ${duplicateCount} 笔，冲突 ${conflictCount} 笔。`,
      } as BackupImportRecord);
    });
    const autoSync = (await db.appSettings.get('auto_sync_after_import'))?.value;
    if (autoSync) {
      await marketCacheManager.detectAndQueueMissingRanges();
      await MarketTaskExecutor.startOrWakeMarketExecutor();
    }
    return { ledgerCount, transactionCount, duplicateCount, conflictCount };
  }
}

export const backupService = new BackupService();
