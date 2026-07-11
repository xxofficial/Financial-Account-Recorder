import { z } from 'zod';

export const BACKUP_V5_FORMAT = 'recoder-backup-v5' as const;
export const BACKUP_V5_VERSION = 5 as const;

export const tradeTypeSchema = z.enum([
  'BUY', 'SELL', 'DEPOSIT', 'WITHDRAW', 'TRANSFER_OUT', 'TRANSFER_IN',
  'INTEREST', 'SPLIT', 'EXPIRE', 'DIVIDEND', 'TAX', 'FX_CONVERSION', 'OTHER',
]);

export const marketSchema = z.enum(['A_SHARE', 'HK', 'US', 'CASH']);

export const ledgerV5Schema = z.object({
  syncId: z.string().min(1),
  legacyId: z.number().int().positive().optional(),
  name: z.string().min(1),
  type: z.enum(['PERSONAL', 'JOINT']),
  description: z.string(),
  partners: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const transactionV5Schema = z.object({
  syncId: z.string().min(1),
  legacyId: z.number().int().positive().optional(),
  ledgerSyncId: z.string().min(1),
  tradeType: tradeTypeSchema,
  platform: z.string().min(1),
  sourceChannel: z.string().nullable(),
  externalReference: z.string().nullable(),
  market: marketSchema,
  symbol: z.string(),
  name: z.string(),
  tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tradeTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  price: z.number(),
  quantity: z.number(),
  commission: z.number(),
  tax: z.number(),
  note: z.string(),
  investorName: z.string().nullable(),
  assetType: z.enum(['STOCK', 'OPTION']),
  underlyingSymbol: z.string().nullable(),
  expiryDate: z.string().nullable(),
  strikePrice: z.number().nullable(),
  optionType: z.enum(['CALL', 'PUT']).nullable(),
  contractKey: z.string().nullable(),
  occSymbol: z.string().nullable(),
  fxFromCurrency: z.string().nullable(),
  fxFromAmount: z.number().nullable(),
  fxToCurrency: z.string().nullable(),
  fxToAmount: z.number().nullable(),
  fxRate: z.number().nullable(),
  fingerprint: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const backupV5Schema = z.object({
  format: z.literal(BACKUP_V5_FORMAT),
  version: z.literal(BACKUP_V5_VERSION),
  generatedAt: z.number().int().nonnegative(),
  displayCurrency: z.string(),
  enabledPlatforms: z.array(z.string()),
  feePlanSelections: z.record(z.string()).default({}),
  ledgers: z.array(ledgerV5Schema),
  transactions: z.array(transactionV5Schema),
});

export type BackupV5 = z.infer<typeof backupV5Schema>;
export type BackupV5Ledger = z.infer<typeof ledgerV5Schema>;
export type BackupV5Transaction = z.infer<typeof transactionV5Schema>;

/**
 * Android/Web 旧版本使用 version=4。解析器特意保留未知字段，确保历史备份
 * 中由旧版本附加的期权、汇兑字段不会被导入前丢弃。
 */
export const backupV4Schema = z.object({
  version: z.number().optional().default(4),
  displayCurrency: z.string().optional().default('CNY'),
  enabledPlatforms: z.array(z.string()).optional().default([]),
  selectedPlatform: z.string().nullable().optional(),
  ledgers: z.array(z.record(z.unknown())).optional().default([]),
  transactions: z.array(z.record(z.unknown())).optional().default([]),
}).passthrough();

export type BackupV4 = z.infer<typeof backupV4Schema>;

export function parseSupportedBackup(value: unknown):
  | { kind: 'v4'; value: BackupV4 }
  | { kind: 'v5'; value: BackupV5 } {
  const candidate = value as { format?: unknown; version?: unknown };
  if (candidate?.format === BACKUP_V5_FORMAT || candidate?.version === BACKUP_V5_VERSION) {
    return { kind: 'v5', value: backupV5Schema.parse(value) };
  }
  return { kind: 'v4', value: backupV4Schema.parse(value) };
}

export interface NativeImportCandidate {
  id: string;
  source: 'EMAIL' | 'PDF' | 'SHARED_TEXT';
  platform: string;
  externalReference: string | null;
  receivedAt: number;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'IMPORTED' | 'DUPLICATE' | 'FAILED';
  message?: string;
}
