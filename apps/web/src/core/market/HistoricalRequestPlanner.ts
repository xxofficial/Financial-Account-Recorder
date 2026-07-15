import { MarketWorkItem, MarketProviderConfig, MarketProviderQuotaState } from '../../db/schema';

export interface ProviderCapability {
  providerId: string;
  supportsRealtimeQuotes: boolean;
  supportsHistorical: boolean;
  supportsSymbolRange: boolean;
  supportsMultiSymbolSameRange: boolean;
  supportsMultiSymbolSameDate: boolean;
  supportsRecentLimit: boolean;
  supportsAssetTypes: string[];
  supportsMarkets: string[];
  maxSymbolsPerRequest?: number;
  maxDaysPerRequest?: number;
  maxBarsPerRequest?: number;
  costModel: 'per_request' | 'per_symbol' | 'per_returned_bar' | 'provider_specific' | 'unknown';
  quotaDetection: 'response_headers' | 'user_endpoint_and_response_headers' | 'manual_default' | 'unknown';
}

export interface HistoricalRequestPlan {
  providerId: string;
  providerName: string;
  strategy:
    | 'symbol_range'
    | 'multi_symbol_same_range'
    | 'multi_symbol_same_date'
    | 'multi_symbol_recent_limit'
    | 'realtime_quotes';
  securities: Array<{
    securityKey: string;
    symbol: string;
    market: string;
    assetType: string;
  }>;
  fromDate?: string;
  toDate?: string;
  date?: string;
  limit?: number;
  estimatedCost: number;
  expectedBars?: number;
  workItemIds: string[];
}

export const INITIAL_CAPABILITIES: ProviderCapability[] = [
  {
    providerId: 'stock-sdk',
    supportsRealtimeQuotes: true,
    supportsHistorical: true,
    supportsSymbolRange: true,
    supportsMultiSymbolSameRange: false,
    supportsMultiSymbolSameDate: false,
    supportsRecentLimit: true,
    supportsAssetTypes: ['stock'],
    supportsMarkets: ['A_SHARE', 'HK', 'US'],
    maxSymbolsPerRequest: 1,
    costModel: 'provider_specific',
    quotaDetection: 'unknown'
  },
  {
    providerId: 'android-default',
    supportsRealtimeQuotes: true,
    supportsHistorical: true,
    supportsSymbolRange: true,
    supportsMultiSymbolSameRange: false,
    supportsMultiSymbolSameDate: false,
    supportsRecentLimit: true,
    supportsAssetTypes: ['option'],
    supportsMarkets: ['US'],
    maxSymbolsPerRequest: 1,
    costModel: 'unknown',
    quotaDetection: 'manual_default'
  },
  {
    providerId: 'marketdata',
    supportsRealtimeQuotes: true,
    supportsHistorical: true,
    supportsSymbolRange: true,
    supportsMultiSymbolSameRange: false,
    supportsMultiSymbolSameDate: true,
    supportsRecentLimit: true,
    supportsAssetTypes: ['option'],
    supportsMarkets: ['US'],
    maxSymbolsPerRequest: 1,
    costModel: 'provider_specific',
    quotaDetection: 'user_endpoint_and_response_headers'
  }
];

export class HistoricalRequestPlanner {
  /**
   * Build all executable request plans for pending items
   */
  static buildRequestPlans(input: {
    pendingItems: MarketWorkItem[];
    providerConfigs: MarketProviderConfig[];
    providerCapabilities: ProviderCapability[];
    quotaStates: MarketProviderQuotaState[];
    now: number;
  }): HistoricalRequestPlan[] {
    const { pendingItems, providerConfigs, providerCapabilities, quotaStates, now } = input;
    
    if (pendingItems.length === 0) return [];

    const plans: HistoricalRequestPlan[] = [];

    // Filter to get only enabled and non-cooldown providers
    const activeProviders = providerConfigs
      .filter(c => c.enabled === 1 && (c.apiKey.trim() !== '' || c.provider === 'android-default' || c.provider === 'stock-sdk'))
      .map(c => {
        const capability = providerCapabilities.find(cap => cap.providerId === c.provider);
        const quota = quotaStates.find(q => q.providerId === c.provider);
        return { config: c, capability, quota };
      })
      .filter(p => p.capability !== undefined)
      .sort((a, b) => a.config.priority - b.config.priority);

    for (const p of activeProviders) {
      const cap = p.capability!;
      const quota = p.quota;

      // Check cooldown
      if (quota && quota.cooldownUntil && quota.cooldownUntil > now) {
        continue;
      }
      
      // Check remaining quota (if known, but if we don't have quotaState yet or remaining is not 0, we can run)
      if (quota && quota.remaining !== undefined && quota.remaining <= 0) {
        // Daily quota exhausted, but let's check if it reset
        if (quota.resetAt && quota.resetAt > now) {
          continue;
        }
      }

      // Group pending items by kind
      const realtimeItems = pendingItems.filter(item => item.kind === 'realtime_quote_refresh' && this.isSupported(cap, item));
      const dailyItems = pendingItems.filter(item => item.kind === 'daily_close_update' && this.isSupported(cap, item));
      const rangeItems = pendingItems.filter(item => item.kind === 'historical_range_fill' && this.isSupported(cap, item));

      // Strategy 1: Real-time quotes
      if (realtimeItems.length > 0 && cap.supportsRealtimeQuotes) {
        const maxBatch = cap.maxSymbolsPerRequest || 10;
        const batch = realtimeItems.slice(0, maxBatch);
        plans.push({
          providerId: cap.providerId,
          providerName: cap.providerId,
          strategy: 'realtime_quotes',
          securities: batch.map(item => ({
            securityKey: item.securityKey || '',
            symbol: item.symbol || '',
            market: item.market || '',
            assetType: item.assetType || ''
          })),
          estimatedCost: batch.length,
          workItemIds: batch.map(b => b.id)
        });
      }

      // Strategy 2: Multi-symbol same date (daily close update)
      if (dailyItems.length > 0 && cap.supportsHistorical) {
        if (cap.supportsMultiSymbolSameDate) {
          // Group by tradeDate
          const dateGroups: Record<string, typeof dailyItems> = {};
          for (const item of dailyItems) {
            const date = item.tradeDate || '';
            if (!date) continue;
            if (!dateGroups[date]) dateGroups[date] = [];
            dateGroups[date].push(item);
          }

          for (const [date, items] of Object.entries(dateGroups)) {
            const maxBatch = cap.maxSymbolsPerRequest || 10;
            const batch = items.slice(0, maxBatch);
            plans.push({
              providerId: cap.providerId,
              providerName: cap.providerId,
              strategy: 'multi_symbol_same_date',
              securities: batch.map(item => ({
                securityKey: item.securityKey || '',
                symbol: item.symbol || '',
                market: item.market || '',
                assetType: item.assetType || ''
              })),
              date,
              estimatedCost: batch.length,
              workItemIds: batch.map(b => b.id)
            });
          }
        } else {
          // Individual symbol_range of 1 day
          for (const item of dailyItems) {
            const date = item.tradeDate;
            if (!date) continue;
            plans.push({
              providerId: cap.providerId,
              providerName: cap.providerId,
              strategy: 'symbol_range',
              securities: [{
                securityKey: item.securityKey || '',
                symbol: item.symbol || '',
                market: item.market || '',
                assetType: item.assetType || ''
              }],
              fromDate: date,
              toDate: date,
              estimatedCost: 1,
              workItemIds: [item.id]
            });
          }
        }
      }

      // Strategy 3: Historical range fill
      if (rangeItems.length > 0 && cap.supportsHistorical) {
        if (cap.supportsMultiSymbolSameRange) {
          // Group by same fromDate and toDate
          const rangeGroups: Record<string, typeof rangeItems> = {};
          for (const item of rangeItems) {
            const f = item.fetchFromDate || item.requiredFromDate || '';
            const t = item.fetchToDate || item.requiredToDate || '';
            const key = `${f}:${t}`;
            if (!rangeGroups[key]) rangeGroups[key] = [];
            rangeGroups[key].push(item);
          }

          for (const [key, items] of Object.entries(rangeGroups)) {
            const [f, t] = key.split(':');
            const maxBatch = cap.maxSymbolsPerRequest || 8;
            const batch = items.slice(0, maxBatch);
            plans.push({
              providerId: cap.providerId,
              providerName: cap.providerId,
              strategy: 'multi_symbol_same_range',
              securities: batch.map(item => ({
                securityKey: item.securityKey || '',
                symbol: item.symbol || '',
                market: item.market || '',
                assetType: item.assetType || ''
              })),
              fromDate: f,
              toDate: t,
              estimatedCost: batch.length,
              workItemIds: batch.map(b => b.id)
            });
          }
        } else {
          // Individual range fill
          for (const item of rangeItems) {
            const f = item.fetchFromDate || item.requiredFromDate || '';
            const t = item.fetchToDate || item.requiredToDate || '';
            plans.push({
              providerId: cap.providerId,
              providerName: cap.providerId,
              strategy: 'symbol_range',
              securities: [{
                securityKey: item.securityKey || '',
                symbol: item.symbol || '',
                market: item.market || '',
                assetType: item.assetType || ''
              }],
              fromDate: f,
              toDate: t,
              estimatedCost: 1,
              workItemIds: [item.id]
            });
          }
        }
      }
    }

    return plans;
  }

  /**
   * Helper to check if a provider capability supports a specific work item's market and asset type
   */
  private static isSupported(cap: ProviderCapability, item: MarketWorkItem): boolean {
    const market = item.market || '';
    const assetType = (item.assetType || '').toLowerCase();
    
    // Normalize asset type to STOCK or OPTION
    const normalizedAssetType = assetType === 'option' ? 'option' : 'stock';

    const supportsMarket = cap.supportsMarkets.includes(market);
    const supportsAssetType = cap.supportsAssetTypes.includes(normalizedAssetType);

    return supportsMarket && supportsAssetType;
  }
}
