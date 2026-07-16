import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/localDb';
import type { MarketProviderConfig } from '../db/schema';
import { HistoricalRequestPlanner, INITIAL_CAPABILITIES, type HistoricalRequestPlan } from '../core/market/HistoricalRequestPlanner';
import { MarketTaskExecutor } from '../core/market/MarketTaskExecutor';

const plan = (providerId: string): HistoricalRequestPlan => ({
  providerId,
  providerName: providerId,
  strategy: 'symbol_range',
  securities: [{ securityKey: 'US:BRKB', symbol: 'BRKB', market: 'US', assetType: 'stock' }],
  fromDate: '2026-07-01',
  toDate: '2026-07-02',
  estimatedCost: 1,
  workItemIds: ['brkb-history'],
});

const workItem = () => ({
  id: 'brkb-history',
  kind: 'historical_range_fill' as const,
  securityKey: 'US:BRKB',
  symbol: 'BRKB',
  market: 'US',
  assetType: 'stock' as const,
  resolution: '1d' as const,
  requiredFromDate: '2026-07-01',
  requiredToDate: '2026-07-02',
  fetchFromDate: '2026-07-01',
  fetchToDate: '2026-07-02',
  sourceReason: 'manual' as const,
  priority: 1,
  status: 'running' as const,
  attemptCount: 0,
  createdAt: 1,
  updatedAt: 1,
});

describe('MarketTaskExecutor historical fallback', () => {
  beforeEach(async () => {
    await db.marketWorkItems.clear();
    await db.marketRequestLogs.clear();
    await db.marketProviderQuotaStates.clear();
  });

  it('moves a deterministic stock-sdk failure to the configured MarketData fallback', async () => {
    await db.marketWorkItems.put(workItem());

    await (MarketTaskExecutor as any).handleHistoricalFailure(plan('stock-sdk'), {
      ok: false,
      status: 'network_error',
      provider: 'stock-sdk',
      errorCode: 'SDK_REQUEST_ERROR',
      message: 'stock-sdk 请求异常: 美股代码不存在或不支持',
    });

    const item = await db.marketWorkItems.get('brkb-history');
    expect(item).toMatchObject({ status: 'pending', attemptCount: 0, providerTried: ['stock-sdk'] });
    expect(item?.nextRetryAt).toBeUndefined();

    const plans = HistoricalRequestPlanner.buildRequestPlans({
      pendingItems: [item!],
      providerConfigs: [
        { provider: 'stock-sdk', enabled: 1, priority: 0, apiKey: '', baseUrl: 'stock-sdk', optionsJson: '{}', createdAt: 1, updatedAt: 1 },
        { provider: 'marketdata', enabled: 1, priority: 2, apiKey: 'local-token', baseUrl: 'https://api.marketdata.app/v1', optionsJson: '{}', createdAt: 1, updatedAt: 1 },
      ],
      providerCapabilities: INITIAL_CAPABILITIES,
      quotaStates: [],
      now: Date.now(),
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].providerId).toBe('marketdata');
  });

  it('retries a transient stock-sdk connection failure without exhausting the fallback chain', async () => {
    await db.marketWorkItems.put(workItem());

    await (MarketTaskExecutor as any).handleHistoricalFailure(plan('stock-sdk'), {
      ok: false,
      status: 'network_error',
      provider: 'stock-sdk',
      errorCode: 'NETWORK_UNREACHABLE',
      message: 'stock-sdk 请求未能建立连接，将自动重试。',
    });

    const item = await db.marketWorkItems.get('brkb-history');
    expect(item).toMatchObject({ status: 'retry_scheduled', attemptCount: 1 });
    expect(item?.providerTried).toBeUndefined();
  });

  it('uses MarketData after repeated stock-sdk connection failures', async () => {
    await db.marketWorkItems.put({ ...workItem(), attemptCount: 2 });

    await (MarketTaskExecutor as any).handleHistoricalFailure(plan('stock-sdk'), {
      ok: false,
      status: 'network_error',
      provider: 'stock-sdk',
      errorCode: 'NETWORK_UNREACHABLE',
      message: 'stock-sdk 请求未能建立连接，将自动重试。',
    });

    const item = await db.marketWorkItems.get('brkb-history');
    expect(item).toMatchObject({ status: 'pending', attemptCount: 0, providerTried: ['stock-sdk'] });
  });

  it('retries a transient MarketData connection failure instead of marking the symbol unsupported', async () => {
    await db.marketWorkItems.put({ ...workItem(), providerTried: ['stock-sdk'] });

    await (MarketTaskExecutor as any).handleHistoricalFailure(plan('marketdata'), {
      ok: false,
      status: 'network_error',
      provider: 'marketdata',
      errorCode: 'NETWORK_UNREACHABLE',
      message: '请求未能建立连接，将自动重试。',
    });

    const item = await db.marketWorkItems.get('brkb-history');
    expect(item).toMatchObject({ status: 'retry_scheduled', attemptCount: 1, providerTried: ['stock-sdk'] });
  });

  it('turns a MarketData browser CORS failure into a terminal unsupported task', async () => {
    await db.marketWorkItems.put({ ...workItem(), providerTried: ['stock-sdk'] });

    await (MarketTaskExecutor as any).handleHistoricalFailure(plan('marketdata'), {
      ok: false,
      status: 'cors_error',
      provider: 'marketdata',
      errorCode: 'CORS_OR_NETWORK_ERROR',
      message: '请求发生跨域 (CORS) 限制或目标行情服务器不可达。',
    });

    const item = await db.marketWorkItems.get('brkb-history');
    expect(item?.status).toBe('unsupported');
    expect(item?.nextRetryAt).toBeUndefined();
    expect(item?.providerTried).toEqual(['stock-sdk', 'marketdata']);
    expect(item?.lastError).toContain('跨域请求');
  });

  it('does not treat providers already tried by a task as available fallbacks', () => {
    const exhausted = {
      ...workItem(),
      status: 'pending' as const,
      providerTried: ['stock-sdk', 'marketdata'],
    };
    const providerConfigs: MarketProviderConfig[] = [
      { provider: 'stock-sdk', enabled: 1, priority: 0, apiKey: '', baseUrl: 'stock-sdk', optionsJson: '{}', createdAt: 1, updatedAt: 1 },
      { provider: 'marketdata', enabled: 1, priority: 2, apiKey: 'local-token', baseUrl: 'https://api.marketdata.app/v1', optionsJson: '{}', createdAt: 1, updatedAt: 1 },
    ];

    expect(HistoricalRequestPlanner.hasConfiguredProvider(exhausted, providerConfigs, INITIAL_CAPABILITIES)).toBe(false);
    expect(HistoricalRequestPlanner.buildRequestPlans({
      pendingItems: [exhausted],
      providerConfigs,
      providerCapabilities: INITIAL_CAPABILITIES,
      quotaStates: [],
      now: Date.now(),
    })).toHaveLength(0);
  });

  it('does not put the terminal MarketData CORS failure into a temporary provider cooldown', async () => {
    await (MarketTaskExecutor as any).updateQuotaStateFromResponse('marketdata', {
      ok: false,
      status: 'cors_error',
      provider: 'marketdata',
      message: '浏览器跨域限制',
    });

    expect((await db.marketProviderQuotaStates.get('marketdata'))?.cooldownUntil).toBeUndefined();
  });

  it('keeps the executor alive until the earliest retry or provider cooldown expires', () => {
    const now = 1_000;
    expect((MarketTaskExecutor as any).nextRetryAt([
      { nextRetryAt: now + 60_000 },
      { nextRetryAt: now + 30_000 },
    ], now)).toBe(now + 30_000);
    expect((MarketTaskExecutor as any).nextProviderWakeAt([
      { providerId: 'stock-sdk', cooldownUntil: now + 15_000 },
      { providerId: 'marketdata', remaining: 0, resetAt: now + 45_000 },
    ], now)).toBe(now + 15_000);
  });

  it('requeues a running item abandoned by a page reload after taking the executor lock', async () => {
    await db.marketWorkItems.put(workItem());

    await (MarketTaskExecutor as any).recoverAbandonedRunningItems(1234);

    const item = await db.marketWorkItems.get('brkb-history');
    expect(item).toMatchObject({ status: 'pending', updatedAt: 1234 });
    expect(item?.nextRetryAt).toBeUndefined();
  });

  it('treats an empty MarketData response as unsupported instead of completed coverage', async () => {
    await db.marketWorkItems.put({ ...workItem(), providerTried: ['stock-sdk'] });

    await (MarketTaskExecutor as any).handleHistoricalFailure(plan('marketdata'), {
      ok: true,
      status: 'success',
      provider: 'marketdata',
      data: [],
    }, { noData: true });

    expect((await db.marketWorkItems.get('brkb-history'))?.status).toBe('unsupported');
  });
});
