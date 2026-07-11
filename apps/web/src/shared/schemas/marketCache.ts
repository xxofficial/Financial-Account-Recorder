import { z } from 'zod';

// 支持的行情市场（与主应用 provider 保持一致）
export const supportedMarketSet = ['US', 'HK', 'A_SHARE'] as const;

// 支持的资产类型（与 HistoricalBar 表 schema 保持一致）
export const supportedAssetTypeSet = [
  'stock', 'etf', 'option', 'fund', 'crypto', 'forex'
] as const;

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: 'tradeDate 格式必须为 YYYY-MM-DD',
});

// 单根 K 线导入校验（用于缓存包中的 bars）
export const historicalBarImportSchema = z
  .object({
    symbol: z.string().min(1, 'symbol 不能为空'),
    market: z.enum(supportedMarketSet, {
      errorMap: () => ({ message: `market 必须是 ${supportedMarketSet.join(' / ')} 之一` }),
    }),
    assetType: z.enum(supportedAssetTypeSet, {
      errorMap: () => ({ message: `assetType 必须是 ${supportedAssetTypeSet.join(' / ')} 之一` }),
    }),
    resolution: z.literal('1d', {
      errorMap: () => ({ message: 'resolution 必须是 1d' }),
    }),
    tradeDate: dateStringSchema,
    open: z.number().optional(),
    high: z.number().optional(),
    low: z.number().optional(),
    close: z.number().positive('close 必须大于 0'),
    volume: z.number().optional(),
    adjustedClose: z.number().optional(),
    adjustmentMode: z.string().optional(),
    providerId: z.string().optional(),
    fetchedAt: z.number().optional(),
    sourceTimestamp: z.number().optional(),
    dataQuality: z.enum(['normal', 'delayed', 'stale', 'partial', 'no_data']).optional(),
    sourceId: z.string().optional(),
    sourceName: z.string().optional(),
    sourceType: z.string().optional(),
    adjustedMode: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.high !== undefined && data.low !== undefined) {
        return data.high >= data.low;
      }
      return true;
    },
    { message: 'high 必须大于等于 low', path: ['high'] }
  )
  .refine(
    (data) => {
      if (data.high !== undefined) {
        if (data.open !== undefined && data.high < data.open) return false;
        if (data.close !== undefined && data.high < data.close) return false;
      }
      if (data.low !== undefined) {
        if (data.open !== undefined && data.low > data.open) return false;
        if (data.close !== undefined && data.low > data.close) return false;
      }
      return true;
    },
    { message: 'high 必须不小于 open/close，low 必须不大于 open/close', path: ['ohlc'] }
  );

export type HistoricalBarImport = z.infer<typeof historicalBarImportSchema>;

// HistoricalCoverage 导入校验（缓存包中的 coverage）
export const historicalCoverageImportSchema = z.object({
  securityKey: z.string().min(1, 'securityKey 不能为空'),
  resolution: z.literal('1d', { errorMap: () => ({ message: 'resolution 必须是 1d' }) }),
  fromDate: dateStringSchema,
  toDate: dateStringSchema,
  providerId: z.string().optional(),
  coverageStatus: z.enum(['complete', 'partial', 'unknown']).optional(),
  updatedAt: z.number().optional(),
  sourceId: z.string().optional(),
  sourceName: z.string().optional(),
  sourceType: z.string().optional(),
  adjustedMode: z.string().optional(),
});

export type HistoricalCoverageImport = z.infer<typeof historicalCoverageImportSchema>;

// market-cache-v1 文件整体结构
export const marketCacheV1Schema = z.object({
  version: z.literal('market-cache-v1', {
    errorMap: () => ({ message: '缓存包 version 必须是 market-cache-v1' }),
  }),
  generatedAt: z.string().optional(),
  generator: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
  bars: z.array(z.any()).min(0, 'bars 不能为空数组'),
  coverage: z.array(z.any()).optional(),
});

export type MarketCachePackageV1 = {
  version: 'market-cache-v1';
  generatedAt?: string;
  generator?: { name?: string; version?: string };
  bars: HistoricalBarImport[];
  coverage?: HistoricalCoverageImport[];
};

// 单条缺失条目
export const missingMarketDataItemSchema = z.object({
  securityKey: z.string().min(1, 'securityKey 不能为空'),
  symbol: z.string().min(1, 'symbol 不能为空'),
  market: z.enum(supportedMarketSet, {
    errorMap: () => ({ message: `market 必须是 ${supportedMarketSet.join(' / ')} 之一` }),
  }),
  assetType: z.enum(supportedAssetTypeSet, {
    errorMap: () => ({ message: `assetType 必须是 ${supportedAssetTypeSet.join(' / ')} 之一` }),
  }),
  requiredFromDate: dateStringSchema,
  requiredToDate: dateStringSchema,
  preferredFetchFromDate: dateStringSchema,
  preferredFetchToDate: dateStringSchema,
});

export type MissingMarketDataItem = z.infer<typeof missingMarketDataItemSchema>;

// missing-market-data-v1 文件整体结构
export const missingMarketDataV1Schema = z.object({
  version: z.literal('missing-market-data-v1', {
    errorMap: () => ({ message: '缺失清单 version 必须是 missing-market-data-v1' }),
  }),
  generatedAt: z.string().optional(),
  items: z.array(z.any()).min(0, 'items 不能为空数组'),
});

export type MissingMarketDataPackageV1 = {
  version: 'missing-market-data-v1';
  generatedAt?: string;
  items: MissingMarketDataItem[];
};

// 辅助：将任意数组逐项解析为 HistoricalBarImport，返回 { valid, invalid }
export function parseHistoricalBarImports(rawBars: unknown[]): {
  valid: { index: number; bar: HistoricalBarImport }[];
  invalid: { row: number; reason: string }[];
} {
  const valid: { index: number; bar: HistoricalBarImport }[] = [];
  const invalid: { row: number; reason: string }[] = [];

  if (!Array.isArray(rawBars)) {
    return { valid, invalid: [{ row: 0, reason: 'bars 不是数组' }] };
  }

  rawBars.forEach((raw, index) => {
    const result = historicalBarImportSchema.safeParse(raw);
    if (result.success) {
      valid.push({ index, bar: result.data });
    } else {
      const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
      invalid.push({ row: index, reason: messages.join('; ') });
    }
  });

  return { valid, invalid };
}

// 辅助：将任意数组逐项解析为 HistoricalCoverageImport
export function parseHistoricalCoverageImports(rawCoverage: unknown[]): {
  valid: HistoricalCoverageImport[];
  invalid: { row: number; reason: string }[];
} {
  const valid: HistoricalCoverageImport[] = [];
  const invalid: { row: number; reason: string }[] = [];

  if (!Array.isArray(rawCoverage)) return { valid, invalid };

  rawCoverage.forEach((raw, index) => {
    const result = historicalCoverageImportSchema.safeParse(raw);
    if (result.success) {
      valid.push(result.data);
    } else {
      const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
      invalid.push({ row: index, reason: messages.join('; ') });
    }
  });

  return { valid, invalid };
}
