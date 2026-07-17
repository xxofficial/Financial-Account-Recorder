import { StockSDK } from 'stock-sdk';
import type { Transaction } from '../../db/schema';
import { db } from '../../db/localDb';
import { marketFetch } from '../../platform/nativeRuntime';

const EPSILON = 1e-8;

export const CORPORATE_ACTION_AUTO_SYNC_KEY = 'corporate_action_auto_sync';
export const DEFAULT_CORPORATE_ACTION_AUTO_SYNC = true;
export const CORPORATE_ACTION_SYNC_STATE_KEY = 'corporate_action_sync_state_v1';
export const CORPORATE_ACTION_PENDING_SPLITS_KEY = 'corporate_action_pending_splits_v1';

export type CorporateActionMarket = 'A_SHARE' | 'HK' | 'US';

export interface SplitActionEvent {
  market: CorporateActionMarket;
  symbol: string;
  name: string;
  tradeDate: string;
  ratio: number;
  source: 'stock-sdk-eastmoney' | 'yahoo-chart' | 'massive-splits';
  externalReference: string;
  detail: string;
}

export interface SplitActionCandidate extends SplitActionEvent {
  id: string;
  ledgerId: number;
  platform: string;
}

type MarketSyncState = {
  lastAttemptCycle?: Partial<Record<CorporateActionMarket, string>>;
  lastSuccessCycle?: Partial<Record<CorporateActionMarket, string>>;
  lastError?: Partial<Record<CorporateActionMarket, string>>;
};

type CorporateActionSyncState = { ledgers: Record<string, MarketSyncState> };
type StoredPendingSplit = { ledgerId: number; event: SplitActionEvent; storedAt: number };

function shanghaiParts(now: Date): { date: string; minute: number } {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) };
}

function previousDate(date: string): string {
  const midnightUtc = Date.parse(`${date}T00:00:00Z`) - 86_400_000;
  return new Date(midnightUtc).toISOString().slice(0, 10);
}

/** The cycle is eligible only after the relevant market's close-data buffer. */
export function eligibleCorporateActionCycle(market: CorporateActionMarket, now = new Date()): string {
  const { date, minute } = shanghaiParts(now);
  // A/HK close in the afternoon; 18:00 gives the free source time to publish.
  // US closes around 04:00/05:00 Beijing time; 08:00 covers both DST states.
  const cutoff = market === 'US' ? 8 * 60 : 18 * 60;
  return minute >= cutoff ? date : previousDate(date);
}

export function dueCorporateActionMarkets(state: MarketSyncState | undefined, now = new Date()): CorporateActionMarket[] {
  return (['A_SHARE', 'HK', 'US'] as const).filter((market) => state?.lastAttemptCycle?.[market] !== eligibleCorporateActionCycle(market, now));
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function actionReference(event: Pick<SplitActionEvent, 'source' | 'market' | 'symbol' | 'tradeDate' | 'ratio'>): string {
  return `corporate-split:${event.source}:${event.market}:${encodeURIComponent(event.symbol)}:${event.tradeDate}:${event.ratio}`;
}

export function ratioFromDividendDetail(detail: Record<string, unknown>): number | null {
  const total = Number(detail.assignTransferRatio ?? detail.BONUS_IT_RATIO ?? 0);
  const bonus = Number(detail.bonusRatio ?? detail.BONUS_RATIO ?? 0);
  const transfer = Number(detail.transferRatio ?? detail.IT_RATIO ?? 0);
  const sharesPerTen = Number.isFinite(total) && total > 0 ? total : (Number.isFinite(bonus) ? bonus : 0) + (Number.isFinite(transfer) ? transfer : 0);
  if (!Number.isFinite(sharesPerTen) || sharesPerTen <= 0) return null;
  const ratio = 1 + sharesPerTen / 10;
  return Number.isFinite(ratio) && ratio > 0 ? Number(ratio.toFixed(8)) : null;
}

export function parseYahooSplitEvents(payload: unknown, market: 'HK' | 'US', fallbackSymbol: string): SplitActionEvent[] {
  const result = (payload as any)?.chart?.result?.[0];
  const events = result?.events?.splits;
  if (!events || typeof events !== 'object') return [];
  const symbol = String(result?.meta?.symbol || fallbackSymbol).replace(/\.HK$/i, '').replace(/\.US$/i, '');
  return Object.values(events).flatMap((raw: any) => {
    const split = raw?.split || raw;
    const numerator = Number(split?.numerator);
    const denominator = Number(split?.denominator);
    const timestamp = Number(split?.date ?? split?.timestamp);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0 || !Number.isFinite(timestamp)) return [];
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const ratio = Number((numerator / denominator).toFixed(8));
    if (!isValidDate(date) || !Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < EPSILON) return [];
    const event: SplitActionEvent = {
      market,
      symbol: fallbackSymbol,
      name: symbol,
      tradeDate: date,
      ratio,
      source: 'yahoo-chart',
      externalReference: '',
      detail: `Yahoo 拆并股 ${numerator}:${denominator}`,
    };
    event.externalReference = actionReference(event);
    return [event];
  });
}

/** Parses Massive's /v3/reference/splits response. split_to is the post-split share count. */
export function parseMassiveSplitEvents(payload: unknown, fallbackSymbol: string): SplitActionEvent[] {
  const rows = (payload as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return [];
  const symbol = fallbackSymbol.trim().replace(/\.US$/i, '').toUpperCase();
  return rows.flatMap((row: any) => {
    const splitTo = Number(row?.split_to);
    const splitFrom = Number(row?.split_from);
    const tradeDate = String(row?.execution_date || '').slice(0, 10);
    const ratio = Number((splitTo / splitFrom).toFixed(8));
    if (!isValidDate(tradeDate) || !Number.isFinite(splitTo) || !Number.isFinite(splitFrom) || splitTo <= 0 || splitFrom <= 0 || !Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) < EPSILON) return [];
    const event: SplitActionEvent = {
      market: 'US',
      symbol,
      name: String(row?.ticker || symbol),
      tradeDate,
      ratio,
      source: 'massive-splits',
      externalReference: '',
      detail: `Massive 拆并股 ${splitFrom}:${splitTo}`,
    };
    event.externalReference = actionReference(event);
    return [event];
  });
}

function yahooSymbol(symbol: string, market: 'HK' | 'US'): string {
  const raw = symbol.trim().replace(/\.(HK|US)$/i, '');
  return market === 'HK' ? `${raw.padStart(5, '0')}.HK` : raw.toUpperCase();
}

async function fetchYahooSplits(symbol: string, market: 'HK' | 'US'): Promise<SplitActionEvent[]> {
  const period2 = Math.floor(Date.now() / 1000) + 86_400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol, market))}?period1=0&period2=${period2}&interval=1d&events=split`;
  const response = await marketFetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Yahoo 公司行动请求失败 (${response.status})`);
  return parseYahooSplitEvents(await response.json(), market, symbol);
}

// Massive's v3 reference splits endpoint is deprecated; use the current
// Stocks API so the company-action sync remains supported.
const MASSIVE_SPLITS_ENDPOINT = 'https://api.massive.com/stocks/v1/splits';

async function fetchMassiveSplits(symbol: string, apiKey: string): Promise<SplitActionEvent[]> {
  const url = `${MASSIVE_SPLITS_ENDPOINT}?ticker=${encodeURIComponent(symbol.trim().replace(/\.US$/i, '').toUpperCase())}`;
  const response = await marketFetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? `Massive 密钥无效、无权限或套餐不支持 (${response.status})`
    : `Massive 公司行动请求失败 (${response.status})`);
  return parseMassiveSplitEvents(await response.json(), symbol);
}

async function fetchAShareSplits(symbol: string): Promise<SplitActionEvent[]> {
  const sdk = new StockSDK({ fetchImpl: (input: any, init?: any) => marketFetch(input, init) as any });
  const rows = await (sdk as any).reference.dividendDetail(symbol);
  return (Array.isArray(rows) ? rows : []).flatMap((row: any) => {
    const date = row?.exDividendDate;
    const ratio = ratioFromDividendDetail(row || {});
    if (!isValidDate(date) || date > todayIso() || ratio === null || !/(实施|完成)/.test(String(row?.assignProgress || ''))) return [];
    const event: SplitActionEvent = {
      market: 'A_SHARE',
      symbol,
      name: String(row?.name || symbol),
      tradeDate: date,
      ratio,
      source: 'stock-sdk-eastmoney',
      externalReference: '',
      detail: `东方财富送转：每 10 股增加 ${(ratio - 1) * 10} 股`,
    };
    event.externalReference = actionReference(event);
    return [event];
  });
}

/** Fetches split events for symbols already present in the ledger. */
export async function fetchSplitEvents(symbols: Array<{ symbol: string; market: CorporateActionMarket }>): Promise<SplitActionEvent[]> {
  const unique = [...new Map(symbols.map((item) => [`${item.market}:${item.symbol}`, item])).values()];
  const events: SplitActionEvent[] = [];
  const failures: string[] = [];
  const massive = await db.marketProviderConfigs.get('massive');
  const massiveApiKey = massive?.enabled === 1 ? massive.apiKey.trim() : '';
  for (const item of unique) {
    try {
      const rows = item.market === 'A_SHARE'
        ? await fetchAShareSplits(item.symbol)
        : item.market === 'US' && massiveApiKey
          ? await fetchMassiveSplits(item.symbol, massiveApiKey)
          : await fetchYahooSplits(item.symbol, item.market);
      events.push(...rows);
    } catch (error) {
      failures.push(`${item.market}:${item.symbol}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  if (!events.length && failures.length) throw new Error(`所有公司行动端点均失败：${failures.join('；')}`);
  return [...new Map(events.map((event) => [event.externalReference, event])).values()]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.symbol.localeCompare(b.symbol));
}

function readSyncState(value: unknown): CorporateActionSyncState {
  if (!value || typeof value !== 'object' || !('ledgers' in value) || typeof (value as any).ledgers !== 'object') return { ledgers: {} };
  return value as CorporateActionSyncState;
}

function readPendingSplits(value: unknown): StoredPendingSplit[] {
  return Array.isArray(value)
    ? value.filter((item): item is StoredPendingSplit => Boolean(item && typeof item === 'object' && typeof item.ledgerId === 'number' && item.event?.externalReference))
    : [];
}

export async function getPendingSplitEvents(ledgerId: number): Promise<SplitActionEvent[]> {
  const setting = await db.appSettings.get(CORPORATE_ACTION_PENDING_SPLITS_KEY);
  return readPendingSplits(setting?.value).filter((item) => ledgerId === 0 || item.ledgerId === ledgerId).map((item) => item.event);
}

export type CorporateActionSyncResult = {
  dueMarkets: CorporateActionMarket[];
  syncedMarkets: CorporateActionMarket[];
  events: SplitActionEvent[];
  failures: string[];
};

/**
 * Synchronizes raw split events only. It never creates SPLIT transactions;
 * the confirmation page remains the sole writer for ledger company actions.
 */
export async function syncCorporateActionSplits(options: {
  ledgerId: number;
  now?: Date;
  force?: boolean;
}): Promise<CorporateActionSyncResult> {
  const now = options.now ?? new Date();
  const transactions = options.ledgerId === 0
    ? await db.transactions.toArray()
    : await db.transactions.where('ledgerId').equals(options.ledgerId).toArray();
  const ledgerIds = options.ledgerId === 0
    ? [...new Set(transactions.map((transaction) => transaction.ledgerId))]
    : [options.ledgerId];
  const stateSetting = await db.appSettings.get(CORPORATE_ACTION_SYNC_STATE_KEY);
  const state = readSyncState(stateSetting?.value);
  const pendingSetting = await db.appSettings.get(CORPORATE_ACTION_PENDING_SPLITS_KEY);
  const pending = readPendingSplits(pendingSetting?.value);
  const result: CorporateActionSyncResult = { dueMarkets: [], syncedMarkets: [], events: [], failures: [] };

  for (const ledgerId of ledgerIds) {
    const ledgerTransactions = transactions.filter((transaction) => transaction.ledgerId === ledgerId);
    const ledgerState = state.ledgers[String(ledgerId)] ?? {};
    state.ledgers[String(ledgerId)] = ledgerState;
    const dueMarkets = options.force ? ['A_SHARE', 'HK', 'US'] as CorporateActionMarket[] : dueCorporateActionMarkets(ledgerState, now);
    result.dueMarkets.push(...dueMarkets);
    for (const market of dueMarkets) {
      const cycle = eligibleCorporateActionCycle(market, now);
      ledgerState.lastAttemptCycle = { ...ledgerState.lastAttemptCycle, [market]: cycle };
      const symbols = [...new Map(ledgerTransactions
        .filter((transaction) => transaction.assetType === 'STOCK' && transaction.market === market)
        .map((transaction) => [transaction.symbol, { symbol: transaction.symbol, market }])).values()];
      if (!symbols.length) {
        ledgerState.lastSuccessCycle = { ...ledgerState.lastSuccessCycle, [market]: cycle };
        continue;
      }
      try {
        const events = await fetchSplitEvents(symbols);
        result.events.push(...events);
        result.syncedMarkets.push(market);
        ledgerState.lastSuccessCycle = { ...ledgerState.lastSuccessCycle, [market]: cycle };
        const withoutPreviousForLedger = pending.filter((item) => item.ledgerId !== ledgerId);
        const existingForLedger = pending.filter((item) => item.ledgerId === ledgerId);
        const merged = new Map(existingForLedger.map((item) => [item.event.externalReference, item]));
        for (const event of events) merged.set(event.externalReference, { ledgerId, event, storedAt: Date.now() });
        pending.splice(0, pending.length, ...withoutPreviousForLedger, ...merged.values());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failures.push(`${market}: ${message}`);
        ledgerState.lastError = { ...ledgerState.lastError, [market]: message };
      }
    }
  }
  await db.appSettings.put({ key: CORPORATE_ACTION_SYNC_STATE_KEY, value: state, updatedAt: Date.now() });
  await db.appSettings.put({ key: CORPORATE_ACTION_PENDING_SPLITS_KEY, value: pending, updatedAt: Date.now() });
  return result;
}

/** Called at app launch only; it does not register a timer or background job. */
export async function syncCorporateActionsOnAppOpen(): Promise<CorporateActionSyncResult | null> {
  const setting = await db.appSettings.get(CORPORATE_ACTION_AUTO_SYNC_KEY);
  // An explicit false remains respected; first-time users sync by default.
  const enabled = typeof setting?.value === 'boolean' ? setting.value : DEFAULT_CORPORATE_ACTION_AUTO_SYNC;
  if (!enabled) return null;
  const ledgerId = (await db.appSettings.get('default_ledger'))?.value;
  return syncCorporateActionSplits({ ledgerId: typeof ledgerId === 'number' ? ledgerId : 1 });
}

export function buildSplitCandidates(transactions: Transaction[], events: SplitActionEvent[]): SplitActionCandidate[] {
  const platformsBySecurity = new Map<string, Set<string>>();
  for (const transaction of transactions) {
    if (transaction.assetType !== 'STOCK' || !['A_SHARE', 'HK', 'US'].includes(transaction.market)) continue;
    const key = `${transaction.market}:${transaction.symbol}`;
    const platforms = platformsBySecurity.get(key) ?? new Set<string>();
    platforms.add(transaction.platform);
    platformsBySecurity.set(key, platforms);
  }
  const existingReferences = new Set(transactions.filter((transaction) => transaction.tradeType === 'SPLIT' && transaction.externalReference).map((transaction) => `${transaction.platform}:${transaction.externalReference}`));
  const existingEvents = new Set(transactions.filter((transaction) => transaction.tradeType === 'SPLIT').map((transaction) => `${transaction.platform}:${transaction.market}:${transaction.symbol}:${transaction.tradeDate}:${transaction.price}`));
  return events.flatMap((event) => [...(platformsBySecurity.get(`${event.market}:${event.symbol}`) ?? [])].flatMap((platform) => {
    if (existingReferences.has(`${platform}:${event.externalReference}`) || existingEvents.has(`${platform}:${event.market}:${event.symbol}:${event.tradeDate}:${event.ratio}`)) return [];
    return [{ ...event, id: `${platform}:${event.externalReference}`, ledgerId: transactions[0]?.ledgerId ?? 0, platform }];
  }));
}

/** Writes user-confirmed split events atomically; duplicate external references are ignored. */
export async function applySplitCandidates(candidates: SplitActionCandidate[]): Promise<number> {
  if (!candidates.length) return 0;
  let created = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const candidate of candidates) {
      const existing = await db.transactions.where('[platform+externalReference]').equals([candidate.platform, candidate.externalReference]).first();
      if (existing) continue;
      const now = Date.now();
      await db.transactions.add({
        ledgerId: candidate.ledgerId,
        tradeType: 'SPLIT',
        platform: candidate.platform,
        sourceChannel: candidate.source === 'stock-sdk-eastmoney'
          ? 'CORPORATE_ACTION_STOCK_SDK'
          : candidate.source === 'massive-splits' ? 'CORPORATE_ACTION_MASSIVE' : 'CORPORATE_ACTION_YAHOO',
        externalReference: candidate.externalReference,
        market: candidate.market,
        symbol: candidate.symbol,
        name: candidate.name,
        tradeDate: candidate.tradeDate,
        tradeTime: '09:30:00',
        price: candidate.ratio,
        quantity: 1,
        commission: 0,
        tax: 0,
        note: `用户确认公司行动：${candidate.detail}`,
        createdAt: now,
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
        transferGroupId: null,
        transferCounterpartyPlatform: null,
      });
      created += 1;
    }
  });
  return created;
}
