export interface Ledger {
  id?: number;
  /** Stable identifier used by recoder-backup-v5; IndexedDB ids remain local only. */
  syncId?: string;
  name: string;
  type: 'PERSONAL' | 'JOINT';
  description: string;
  partners: string; // Comma-separated list of partners, e.g., "Me,Alice"
  createdAt: number;
  updatedAt: number;
}

export type TradeType = 
  | 'BUY' 
  | 'SELL' 
  | 'DEPOSIT' 
  | 'WITHDRAW' 
  | 'TRANSFER_OUT' 
  | 'TRANSFER_IN' 
  | 'INTEREST' 
  | 'SPLIT' 
  | 'EXPIRE' 
  | 'DIVIDEND' 
  | 'TAX' 
  | 'FX_CONVERSION' 
  | 'OTHER';

export interface Transaction {
  id?: number;
  /** Stable identifier used for idempotent v5 backup imports. */
  syncId?: string;
  /** Canonical content digest used when legacy transactions lack an external reference. */
  sourceFingerprint?: string;
  ledgerId: number; // Foreign key to Ledger
  tradeType: TradeType;
  platform: string; // e.g., LONGBRIDGE, ZHUORUI, SCHWAB, HSBC
  sourceChannel: string | null; // Import source channel (manual input is null)
  externalReference: string | null; // External ID mapping
  market: 'A_SHARE' | 'HK' | 'US' | 'CASH';
  symbol: string; // Ticker symbol, e.g. "AAPL" or "00700"
  name: string; // Ticker name, e.g. "Apple Inc."
  tradeDate: string; // YYYY-MM-DD
  tradeTime: string; // HH:mm:ss
  price: number;
  quantity: number;
  commission: number; // Broker commission fee
  tax: number; // Government taxes / platform fees
  note: string;
  createdAt: number;
  updatedAt: number;
  investorName: string | null;

  // Option specific extension fields
  assetType: 'STOCK' | 'OPTION';
  underlyingSymbol: string | null;
  expiryDate: string | null; // YYYY-MM-DD
  strikePrice: number | null;
  optionType: 'CALL' | 'PUT' | null;

  // OCC-standard option contract identifiers (auto-generated when saving option transactions)
  contractKey?: string | null; // e.g. US:OPTION:AAPL:2026-01-16:C:200
  occSymbol?: string | null;   // e.g. AAPL260116C00200000

  // Currency exchange/FX fields
  fxFromCurrency: string | null;
  fxFromAmount: number | null;
  fxToCurrency: string | null;
  fxToAmount: number | null;
  fxRate: number | null;
}

export interface QuoteSnapshot {
  id: string; // Composite key formatted as `${market}:${symbol}`
  symbol: string;
  market: string;
  name: string;
  assetType: 'STOCK' | 'OPTION';
  currentPrice: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string;
  provider: string; // e.g. "itick", "twelvedata"
  fetchedAt: number;
  requestStatus?: MarketRequestStatus;
}

export interface HistoricalDailyBar {
  id: string; // Unique key formatted as `${market}:${symbol}:${assetType}:${date}`
  symbol: string;
  market: string;
  assetType: 'STOCK' | 'OPTION';
  date: string; // YYYY-MM-DD
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  provider: string;
  fetchedAt: number;
}

export interface MarketProviderConfig {
  provider: 'itick' | 'twelvedata' | 'marketdata' | 'android-default';
  enabled: number; // 1 = enabled, 0 = disabled (IndexedDB cannot index booleans)
  priority: number;
  apiKey: string;
  baseUrl: string;
  optionsJson: string; // JSON string for provider specific configurations
  createdAt: number;
  updatedAt: number;
}

export interface AppSetting {
  key: string; // e.g. "default_ledger", "last_backup_time"
  value: any;
  updatedAt: number;
}

export interface BackupImportRecord {
  id?: number;
  fileName: string;
  importedAt: number;
  transactionCount: number;
  ledgerCount: number;
  dateRangeStart: string;
  dateRangeEnd: string;
  status: 'SUCCESS' | 'FAILED';
  message: string;
}

export type MarketRequestStatus =
  | 'idle'
  | 'pending'
  | 'cache_hit'
  | 'success'
  | 'partial_success'
  | 'failed'
  | 'rate_limited'
  | 'network_error'
  | 'cors_error'
  | 'timeout'
  | 'provider_unconfigured'
  | 'fallback'
  | 'skipped';

export type MarketRequestLogType =
  | 'request_start'
  | 'request_success'
  | 'request_partial_success'
  | 'request_failed'
  | 'fallback'
  | 'quota_update'
  | 'rate_limited'
  | 'auth_failed'
  | 'provider_unsupported'
  | 'executor_state';

export interface MarketRequestLog {
  id?: number;
  providerId?: string;
  type: MarketRequestLogType;
  workItemIds?: string[];
  message: string;
  detail?: any;
  createdAt: number;
}

export interface HistoricalBar {
  id?: string; // Unique key: `${market}:${symbol}:${assetType}:${resolution}:${tradeDate}`
  securityKey: string; // `${market}:${symbol}`
  symbol: string;
  market: string;
  assetType: 'stock' | 'etf' | 'option' | 'fund' | 'crypto' | 'forex';
  resolution: '1d';
  tradeDate: string; // YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
  adjustedClose?: number;
  adjustmentMode?: 'raw' | 'split_adjusted' | 'dividend_adjusted' | 'unknown';
  providerId: string;
  fetchedAt: number;
  sourceTimestamp?: number;
  dataQuality: 'normal' | 'delayed' | 'stale' | 'partial' | 'no_data';

  // 外部来源元数据（为桌面预取工具预留）
  sourceId?: string;
  sourceName?: string;
  sourceType?: string;
  adjustedMode?: string;
}

export interface HistoricalCoverage {
  id?: number;
  securityKey: string;
  resolution: '1d';
  fromDate: string;
  toDate: string;
  providerId: string;
  coverageStatus: 'complete' | 'partial' | 'unknown';
  updatedAt: number;

  // 外部来源元数据（为桌面预取工具预留）
  sourceId?: string;
  sourceName?: string;
  sourceType?: string;
  adjustedMode?: string;
}

export interface OptionContract {
  id?: number;
  contractKey: string; // US:OPTION:{underlying}:{expirationDate}:{C|P}:{strike}
  occSymbol: string;
  providerSymbol?: string; // O:{occSymbol}
  underlying: string;
  market: 'US';
  expirationDate: string; // YYYY-MM-DD
  side: 'call' | 'put';
  strike: number;
  multiplier?: number; // default 100
  exerciseStyle?: 'american' | 'european' | 'bermudan' | 'unknown';
  settlementType?: 'physical' | 'cash' | 'unknown';
  sourceId?: string;
  verifiedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface OptionDailyBar {
  id?: string; // {contractKey}:{tradeDate}
  contractKey: string;
  occSymbol: string;
  providerSymbol?: string;
  underlying: string;
  market: 'US';
  expirationDate: string;
  side: 'call' | 'put';
  strike: number;
  tradeDate: string; // YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  adjusted?: boolean;
  providerId: string;
  sourceId?: string;
  fetchedAt: number;
  dataQuality:
    | 'normal'
    | 'thin_volume'
    | 'no_trade'
    | 'no_data'
    | 'provider_error'
    | 'imported'
    | 'unknown';
}

export interface OptionDailyBarCoverage {
  id?: number;
  contractKey: string;
  occSymbol: string;
  fromDate: string;
  toDate: string;
  providerId: string;
  coverageStatus: 'complete' | 'partial' | 'no_data' | 'unknown';
  updatedAt: number;
}

export interface MarketWorkItem {
  id: string;
  kind:
    | 'historical_range_fill'
    | 'option_daily_bar_fill'
    | 'daily_close_update'
    | 'realtime_quote_refresh'
    | 'provider_quota_probe';
  securityKey?: string;
  symbol?: string;
  market?: string;
  assetType?: 'stock' | 'etf' | 'option' | 'fund' | 'crypto' | 'forex';
  resolution?: '1d';
  requiredFromDate?: string;
  requiredToDate?: string;
  fetchFromDate?: string;
  fetchToDate?: string;
  tradeDate?: string;

  // Option-specific fields for option_daily_bar_fill
  contractKey?: string;
  occSymbol?: string;
  providerSymbol?: string;
  expirationDate?: string;
  side?: 'call' | 'put';
  strike?: number;

  sourceReason:
    | 'backup_import'
    | 'daily_close_update'
    | 'transaction_created'
    | 'transaction_imported'
    | 'market_cache_import_reconcile'
    | 'manual_prefetch'
    | 'portfolio_page_refresh'
    | 'manual';
  priority: number;
  status:
    | 'pending'
    | 'running'
    | 'paused_quota'
    | 'paused_provider_error'
    | 'retry_scheduled'
    | 'success'
    | 'partial_success'
    | 'no_data'
    | 'unsupported'
    | 'failed_permanent'
    | 'plan_limited';
  attemptCount: number;
  lastAttemptAt?: number;
  nextRetryAt?: number;
  providerTried?: string[];
  preferredProviderId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MarketProviderQuotaState {
  providerId: string;
  detection:
    | 'response_headers'
    | 'user_endpoint_and_response_headers'
    | 'manual_default'
    | 'unknown';
  limit?: number;
  remaining?: number;
  consumedLastRequest?: number;
  resetAt?: number;
  windowType?: 'minute' | 'day' | 'unknown';
  source:
    | 'official_header'
    | 'official_user_endpoint'
    | 'free_plan_default'
    | 'local_estimation';
  confidence: 'high' | 'medium' | 'low';
  cooldownUntil?: number;
  lastErrorType?: string;
  lastObservedAt?: number;
}

export interface MarketExecutorState {
  id: 'global';
  executorId?: string;
  status:
    | 'idle'
    | 'running'
    | 'paused_all_quota'
    | 'paused_no_work'
    | 'stopped'
    | 'error';
  activeProviderId?: string;
  activeProviderName?: string;
  activeWorkItemIds?: string[];
  currentMessage?: string;
  startedAt?: number;
  lastHeartbeatAt?: number;
  updatedAt: number;
}
