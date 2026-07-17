import { db } from '../../db/localDb';
import { MarketProviderQuotaState, QuoteSnapshot, MarketRequestStatus } from '../../db/schema';
import { HistoricalRequestPlanner, INITIAL_CAPABILITIES, HistoricalRequestPlan } from './HistoricalRequestPlanner';
import { StockSdkProvider } from './stockSdkProvider';
import { AndroidDefaultMarketProvider } from './androidDefaultMarketProvider';
import { MarketDataAppProvider } from './marketDataProvider';
import { MassiveProvider } from './massiveProvider';
import { MarketDataProvider } from './marketDataProvider';
import { logMarketRequest, MarketDataResult } from './marketRequestHelper';

// Singletons
const providers: Record<string, MarketDataProvider> = {
  'android-default': new AndroidDefaultMarketProvider(),
  'stock-sdk': new StockSdkProvider(),
  marketdata: new MarketDataAppProvider(),
  massive: new MassiveProvider(),
};

/**
 * Helper to determine if two date ranges are mergeable (overlap or adjacent within 3 days)
 */
function areRangesMergeable(
  fromA: string, toA: string,
  fromB: string, toB: string
): boolean {
  const startA = new Date(fromA);
  const endA = new Date(toA);
  const startB = new Date(fromB);
  const endB = new Date(toB);

  // Check overlap
  const overlap = (startA <= endB && startB <= endA);
  if (overlap) return true;

  // Check adjacency (up to 3 days to span weekends)
  const diff1 = startB.getTime() - endA.getTime();
  const diff1Days = diff1 / (1000 * 60 * 60 * 24);
  if (diff1Days > 0 && diff1Days <= 3) return true;

  const diff2 = startA.getTime() - endB.getTime();
  const diff2Days = diff2 / (1000 * 60 * 60 * 24);
  if (diff2Days > 0 && diff2Days <= 3) return true;

  return false;
}

export class MarketTaskExecutor {
  private static heartbeatInterval: any = null;

  private static async waitForQueueWake(
    executorId: string,
    resumeAt: number,
    message: string,
  ): Promise<void> {
    const delay = Math.max(250, resumeAt - Date.now());
    await db.marketExecutorState.update('global', {
      status: 'running',
      activeProviderId: undefined,
      activeProviderName: undefined,
      activeWorkItemIds: [],
      currentMessage: message,
      updatedAt: Date.now(),
    });
    console.log(`Executor ${executorId} waiting ${delay}ms before resuming.`);
    await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
  }

  private static nextRetryAt(items: Array<{ nextRetryAt?: number }>, now: number): number | undefined {
    const retryTimes = items
      .map((item) => item.nextRetryAt)
      .filter((retryAt): retryAt is number => typeof retryAt === 'number' && retryAt > now);
    return retryTimes.length > 0 ? Math.min(...retryTimes) : undefined;
  }

  private static nextProviderWakeAt(quotaStates: MarketProviderQuotaState[], now: number): number | undefined {
    const wakeTimes = quotaStates
      .flatMap((quota) => [quota.cooldownUntil, quota.remaining !== undefined && quota.remaining <= 0 ? quota.resetAt : undefined])
      .filter((wakeAt): wakeAt is number => typeof wakeAt === 'number' && wakeAt > now);
    return wakeTimes.length > 0 ? Math.min(...wakeTimes) : undefined;
  }

  /**
   * A page reload can interrupt a browser request after its work item has been
   * claimed.  Once this executor has taken the global lock, those `running`
   * rows cannot belong to a live executor and must be made runnable again.
   */
  private static async recoverAbandonedRunningItems(now: number): Promise<void> {
    const abandonedItems = await db.marketWorkItems.where('status').equals('running').toArray();
    if (abandonedItems.length === 0) return;

    await db.transaction('rw', db.marketWorkItems, async () => {
      for (const item of abandonedItems) {
        await db.marketWorkItems.update(item.id, {
          status: 'pending',
          nextRetryAt: undefined,
          lastError: item.lastError || '上次行情同步被页面中断，已自动重新加入队列。',
          updatedAt: now,
        });
      }
    });
  }

  /**
   * Start or wake up the executor
   */
  static async startOrWakeMarketExecutor(): Promise<void> {
    const now = Date.now();
    const state = await db.marketExecutorState.get('global');

    if (state && state.status === 'running') {
      const lastHeartbeat = state.lastHeartbeatAt || 0;
      // If the executor has been active in the last 30s, do not start a new one
      if (now - lastHeartbeat < 30000) {
        console.log('An active market task executor is already running.');
        return;
      }
    }

    // Otherwise, start/takeover execution
    const executorId = Math.random().toString(36).substring(2, 10);
    await db.marketExecutorState.put({
      id: 'global',
      executorId,
      status: 'running',
      startedAt: now,
      lastHeartbeatAt: now,
      updatedAt: now
    });

    await this.recoverAbandonedRunningItems(now);

    console.log(`Starting MarketTaskExecutor loop: ${executorId}`);
    
    // Start heartbeat
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(async () => {
      const currentState = await db.marketExecutorState.get('global');
      if (currentState && currentState.executorId === executorId && currentState.status === 'running') {
        await db.marketExecutorState.update('global', {
          lastHeartbeatAt: Date.now(),
          updatedAt: Date.now()
        });
      } else {
        // We lost the lock, clean up interval
        clearInterval(this.heartbeatInterval);
      }
    }, 10000);

    // Trigger loop in background
    this.runExecutorLoop(executorId).catch(err => {
      console.error('Executor loop failed with error:', err);
    });
  }

  /**
   * Run the main task loop
   */
  private static async runExecutorLoop(executorId: string): Promise<void> {
    try {
      while (true) {
        // 1. Verify that this executor still owns the lock
        const currentState = await db.marketExecutorState.get('global');
        if (!currentState || currentState.executorId !== executorId || currentState.status !== 'running') {
          console.log(`Executor ${executorId} lost lock. Terminating loop.`);
          break;
        }

        // 2. Load executable work items sorted by priority
        const pendingItems = await db.marketWorkItems
          .where('status')
          .anyOf(['pending', 'retry_scheduled', 'paused_quota', 'paused_provider_error'])
          .toArray();

        const now = Date.now();
        const executableItems = pendingItems
          .filter(item => !item.nextRetryAt || item.nextRetryAt <= now)
          .sort((a, b) => b.priority - a.priority);

        if (executableItems.length === 0) {
          const retryAt = this.nextRetryAt(pendingItems, now);
          if (retryAt) {
            await this.waitForQueueWake(
              executorId,
              retryAt,
              `等待下一次行情重试：${new Date(retryAt).toLocaleTimeString('zh-CN')}`,
            );
            continue;
          }
          console.log('No executable work items found. Executor entering idle/paused.');
          await db.marketExecutorState.update('global', {
            status: 'paused_no_work',
            activeProviderId: undefined,
            activeProviderName: undefined,
            activeWorkItemIds: [],
            currentMessage: '等待行情同步任务中...',
            updatedAt: now
          });
          break;
        }

        // 3. Load provider configs & quota states
        const providerConfigs = await db.marketProviderConfigs.toArray();
        const quotaStates = await db.marketProviderQuotaStates.toArray();

        // 4. Generate plans
        const plans = HistoricalRequestPlanner.buildRequestPlans({
          pendingItems: executableItems,
          providerConfigs,
          providerCapabilities: INITIAL_CAPABILITIES,
          quotaStates,
          now
        });

        if (plans.length === 0) {
          const unsupportedItems = executableItems.filter((item) => !HistoricalRequestPlanner.hasConfiguredProvider(
            item,
            providerConfigs,
            INITIAL_CAPABILITIES,
          ));
          if (unsupportedItems.length > 0) {
            await db.transaction('rw', db.marketWorkItems, async () => {
              for (const item of unsupportedItems) {
                await db.marketWorkItems.update(item.id, {
                  status: 'unsupported',
                  nextRetryAt: undefined,
                  lastError: item.providerTried?.length
                    ? '已尝试所有已配置行情源，当前没有可用回退源。'
                    : '当前没有支持此标的的已配置行情源。',
                  updatedAt: now,
                });
              }
            });
            // Re-evaluate the remaining queue.  This avoids presenting an
            // unsupported task as a quota pause that can never self-heal.
            continue;
          }
          const providerWakeAt = this.nextProviderWakeAt(quotaStates, now);
          if (providerWakeAt) {
            await this.waitForQueueWake(
              executorId,
              providerWakeAt,
              `行情源冷却中，将于 ${new Date(providerWakeAt).toLocaleTimeString('zh-CN')} 自动继续同步。`,
            );
            continue;
          }
          console.log('No executable request plans could be constructed (providers cooldown or quota limit).');
          await db.marketExecutorState.update('global', {
            status: 'paused_all_quota',
            activeProviderId: undefined,
            activeProviderName: undefined,
            activeWorkItemIds: [],
            currentMessage: '所有支持的行情接口额度不足或处于冷却状态，等待恢复...',
            updatedAt: now
          });
          break;
        }

        // 5. Choose the best plan
        // Prioritize realtime_quotes, otherwise pick the first plan (highest priority provider)
        let plan = plans.find(p => p.strategy === 'realtime_quotes');
        if (!plan) {
          plan = plans[0];
        }

        // 6. Update executor state
        let actionMsg = '';
        if (plan.strategy === 'realtime_quotes') {
          actionMsg = `正在从 ${plan.providerId} 刷新当前持仓行情：${plan.securities.length} 个标的`;
        } else if (plan.strategy === 'multi_symbol_same_date') {
          actionMsg = `正在从 ${plan.providerId} 获取多股历史收盘价格 (${plan.date})：${plan.securities.length} 个标的`;
        } else {
          const firstSec = plan.securities[0];
          actionMsg = `正在从 ${plan.providerId} 获取历史价格：${firstSec.symbol} (${plan.fromDate} ~ ${plan.toDate})`;
        }

        await db.marketExecutorState.update('global', {
          activeProviderId: plan.providerId,
          activeProviderName: plan.providerId,
          activeWorkItemIds: plan.workItemIds,
          currentMessage: actionMsg,
          updatedAt: Date.now()
        });

        // Mark items as running
        await db.transaction('rw', db.marketWorkItems, async () => {
          for (const itemId of plan!.workItemIds) {
            await db.marketWorkItems.update(itemId, { status: 'running', updatedAt: Date.now() });
          }
        });

        // 7. Execute plan
        try {
          const result = await this.executePlan(plan, providerConfigs.find(c => c.provider === plan!.providerId)?.apiKey || '');
          
          // 8. Update Quota state
          await this.updateQuotaStateFromResponse(plan.providerId, result);

          // 9. Handle results and save data
          await this.handlePlanResult(plan, result);
        } catch (execErr: any) {
          console.error(`Executor failed executing plan:`, execErr);
          // Put items in retry
          await db.transaction('rw', db.marketWorkItems, async () => {
            for (const itemId of plan!.workItemIds) {
              const item = await db.marketWorkItems.get(itemId);
              if (item) {
                const attempt = item.attemptCount + 1;
                const nextRetry = Date.now() + Math.min(30 * 1000 * Math.pow(2, attempt), 2 * 60 * 60 * 1000);
                await db.marketWorkItems.update(itemId, {
                  status: attempt >= 5 ? 'failed_permanent' : 'retry_scheduled',
                  attemptCount: attempt,
                  nextRetryAt: nextRetry,
                  lastError: execErr?.message || String(execErr),
                  updatedAt: Date.now()
                });
              }
            }
          });
        }
      }
    } finally {
      // Release lock if we are the current running executor
      const state = await db.marketExecutorState.get('global');
      if (state && state.executorId === executorId) {
        await db.marketExecutorState.update('global', {
          status: 'idle',
          activeProviderId: undefined,
          activeProviderName: undefined,
          activeWorkItemIds: [],
          currentMessage: '空闲',
          updatedAt: Date.now()
        });
      }
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }
  }

  /**
   * Execute request based on plan strategy
   */
  private static async executePlan(plan: HistoricalRequestPlan, apiKey: string): Promise<MarketDataResult<any>> {
    const p = providers[plan.providerId];
    if (!p) {
      return { ok: false, status: 'provider_unconfigured', provider: plan.providerId, message: 'Provider not found' };
    }

    if (plan.strategy === 'realtime_quotes') {
      return p.fetchQuotes(plan.securities as any, apiKey);
    }

    // For EOD history calls
    if (plan.strategy === 'symbol_range') {
      const sec = plan.securities[0];
      return p.fetchHistoricalBars(sec.symbol, sec.market, sec.assetType as any, plan.fromDate!, plan.toDate!, apiKey);
    }

    // For multi-symbol range or same-date
    // Loop through individual securities sequentially and combine results
    let ok = true;
    let status: MarketRequestStatus = 'success';
    const combinedData: any[] = [];
    let lastResponse: Response | undefined;
    let message = '请求成功';
    let errorCode = '';

    for (const sec of plan.securities) {
      const f = plan.strategy === 'multi_symbol_same_date' ? plan.date! : plan.fromDate!;
      const t = plan.strategy === 'multi_symbol_same_date' ? plan.date! : plan.toDate!;
      const result = await p.fetchHistoricalBars(sec.symbol, sec.market, sec.assetType as any, f, t, apiKey);
      if (result.response) lastResponse = result.response;
      if (!result.ok) {
        ok = false;
        status = result.status;
        message = result.message || '获取部分标的历史行情失败';
        errorCode = result.errorCode || 'PARTIAL_FAILURE';
      } else if (result.data) {
        combinedData.push(...result.data);
      }
    }

    return {
      ok,
      status,
      provider: plan.providerId,
      data: combinedData,
      message,
      errorCode,
      response: lastResponse
    };
  }

  /**
   * Update quota state based on result and headers
   */
  private static async updateQuotaStateFromResponse(providerId: string, result: MarketDataResult<any>): Promise<void> {
    const now = Date.now();
    const response = result.response;

    let limit: number | undefined;
    let remaining: number | undefined;
    let consumedLastRequest: number | undefined;
    let resetAt: number | undefined;
    let source: MarketProviderQuotaState['source'] = 'local_estimation';
    let confidence: MarketProviderQuotaState['confidence'] = 'low';
    let cooldownUntil: number | undefined;

    const currentCap = INITIAL_CAPABILITIES.find(c => c.providerId === providerId);
    const detection = currentCap?.quotaDetection || 'unknown';

    // Parse headers if available
    if (response && response.headers) {
      if (providerId === 'marketdata') {
        const lim = response.headers.get('X-Api-Ratelimit-Limit');
        const rem = response.headers.get('X-Api-Ratelimit-Remaining');
        const reset = response.headers.get('X-Api-Ratelimit-Reset');
        const cons = response.headers.get('X-Api-Ratelimit-Consumed');
        if (lim) limit = parseInt(lim, 10);
        if (rem) remaining = parseInt(rem, 10);
        if (cons) consumedLastRequest = parseInt(cons, 10);
        if (reset) {
          const parsedReset = parseInt(reset, 10);
          if (!isNaN(parsedReset)) {
            const nowSec = Math.floor(now / 1000);
            resetAt = parsedReset > nowSec ? parsedReset * 1000 : now + parsedReset * 1000;
          }
        }
        source = 'official_header';
        confidence = 'high';
      }
    }

    // Set cooldown based on error status
    if (result.status === 'rate_limited') {
      cooldownUntil = now + (result.retryAfterMs || 60 * 1000);
      remaining = 0;
    } else if (result.status === 'provider_unconfigured' || result.errorCode === 'AUTH_FAILED') {
      cooldownUntil = now + 5 * 60 * 1000; // 5 min cooldown for auth errors
    } else if (!result.ok && ['network_error', 'timeout'].includes(result.status)) {
      cooldownUntil = now + 30 * 1000; // 30s backoff for connection errors
    }

    const state: MarketProviderQuotaState = {
      providerId,
      detection,
      limit,
      remaining,
      consumedLastRequest,
      resetAt,
      source,
      confidence,
      cooldownUntil,
      lastErrorType: result.errorCode || undefined,
      lastObservedAt: now
    };

    await db.marketProviderQuotaStates.put(state);
    
    // Log quota update if rate limited
    if (result.status === 'rate_limited') {
      await logMarketRequest({
        providerId,
        type: 'rate_limited',
        message: `[${providerId}] 触发额度超限频控，进入冷却。`,
        detail: { cooldownUntil }
      });
    }
  }

  private static appendProviderTried(item: { providerTried?: string[] }, providerId: string): string[] {
    return [...new Set([...(item.providerTried || []), providerId])];
  }

  private static shouldFallbackFromStockSdk(
    plan: HistoricalRequestPlan,
    result: MarketDataResult<any>,
    noData: boolean,
    previousAttemptCount: number,
  ): boolean {
    // `fetch failed` does not prove a symbol is unavailable: stock-sdk may
    // rotate through upstream CDN hosts and one attempt can fail while the
    // same symbol succeeds on the next attempt.  Only deterministic SDK
    // failures and empty data advance to the fallback provider.  For a
    // transient connection error we still give stock-sdk two retries first;
    // after the third failed request, try the independently hosted fallback
    // instead of waiting until the task reaches its permanent-failure cap.
    return plan.providerId === 'stock-sdk' && (
      noData ||
      result.errorCode === 'SDK_REQUEST_ERROR' ||
      (result.errorCode === 'NETWORK_UNREACHABLE' && previousAttemptCount >= 2)
    );
  }

  private static shouldFallbackFromMassive(plan: HistoricalRequestPlan, result: MarketDataResult<any>, noData: boolean): boolean {
    return plan.providerId === 'massive' && (
      noData ||
      result.httpStatus === 401 ||
      result.httpStatus === 403 ||
      result.httpStatus === 404 ||
      result.errorCode === 'JSON_PARSE_ERROR'
    );
  }

  private static shouldMarkMarketDataUnsupported(plan: HistoricalRequestPlan, result: MarketDataResult<any>, noData: boolean): boolean {
    return plan.providerId === 'marketdata' && (
      noData ||
      result.status === 'cors_error' ||
      result.status === 'provider_unconfigured' ||
      result.httpStatus === 404 ||
      result.httpStatus === 401 ||
      result.httpStatus === 403
    );
  }

  /** Advance deterministic history failures to the next provider, or stop with a useful terminal reason. */
  private static async handleHistoricalFailure(
    plan: HistoricalRequestPlan,
    result: MarketDataResult<any>,
    options: { noData?: boolean } = {},
  ): Promise<void> {
    const now = Date.now();
    const noData = options.noData === true;
    await db.transaction('rw', db.marketWorkItems, async () => {
      for (const itemId of plan.workItemIds) {
        const item = await db.marketWorkItems.get(itemId);
        if (!item) continue;

        const fallbackFromStockSdk = this.shouldFallbackFromStockSdk(plan, result, noData, item.attemptCount);
        const fallbackFromMassive = this.shouldFallbackFromMassive(plan, result, noData);
        const unsupportedMarketData = this.shouldMarkMarketDataUnsupported(plan, result, noData);
        // Only deterministic provider outcomes consume a fallback source.
        // A transient request failure must keep the current provider eligible
        // for the next retry; otherwise one failed connection makes the task
        // look as if every provider has been exhausted.
        const providerTried = (fallbackFromStockSdk || fallbackFromMassive || unsupportedMarketData)
          ? this.appendProviderTried(item, plan.providerId)
          : item.providerTried;
        if (fallbackFromStockSdk || fallbackFromMassive) {
          await db.marketWorkItems.update(itemId, {
            status: 'pending',
            attemptCount: 0,
            nextRetryAt: undefined,
            providerTried,
            lastError: `${plan.providerId} 未返回可用历史数据，正在尝试下一个行情源。`,
            updatedAt: now,
          });
          continue;
        }

        if (unsupportedMarketData) {
          const reason = result.status === 'cors_error'
            ? '浏览器拒绝了 MarketData.app 的跨域请求，当前连接不可用。'
            : noData
              ? 'MarketData.app 未返回该标的的历史数据，当前暂不支持。'
              : result.httpStatus === 401 || result.httpStatus === 403
                ? 'MarketData.app 凭据无效或无权访问该数据，当前暂不支持。'
              : 'MarketData.app 当前不可用于此请求，当前暂不支持。';
          await db.marketWorkItems.update(itemId, {
            status: 'unsupported',
            attemptCount: item.attemptCount + 1,
            nextRetryAt: undefined,
            providerTried,
            lastError: reason,
            updatedAt: now,
          });
          continue;
        }

        const errStatus = result.status === 'rate_limited' ? 'paused_quota' : 'retry_scheduled';
        const attempt = item.attemptCount + 1;
        const isPerm = attempt >= 5 && errStatus === 'retry_scheduled';
        await db.marketWorkItems.update(itemId, {
          status: isPerm ? 'failed_permanent' : errStatus,
          attemptCount: attempt,
          nextRetryAt: errStatus === 'retry_scheduled'
            ? now + Math.min(30 * 1000 * Math.pow(2, attempt), 2 * 60 * 60 * 1000)
            : undefined,
          lastError: result.message || result.errorCode || result.status,
          updatedAt: now,
        });
      }
    });

  }

  /**
   * Handle result, write quote/bar snapshots and update work items status
   */
  private static async handlePlanResult(plan: HistoricalRequestPlan, result: MarketDataResult<any>): Promise<void> {
    const now = Date.now();

    if (plan.strategy === 'realtime_quotes') {
      // 1. Handling Quote Refresh
      if (result.ok && result.data && Array.isArray(result.data)) {
        const quotes: QuoteSnapshot[] = result.data;
        await db.transaction('rw', [db.quoteSnapshots, db.historicalBars], async () => {
          for (const q of quotes) {
            let currentPrice = q.currentPrice;
            let prevClose = q.previousClose;
            let change = q.change;
            let changePercent = q.changePercent;
            
            const key = `${q.market}:${q.symbol}`;
            const localBars = await db.historicalBars
              .where('securityKey')
              .equals(key)
              .toArray();
            
            if (localBars.length > 0) {
              localBars.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
              const latestBar = localBars[0];
              
              if (prevClose === null || prevClose === undefined) {
                prevClose = latestBar.close;
              }
              
              if (q.assetType === 'OPTION') {
                const nowNY = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
                const dayOfWeek = nowNY.getDay();
                const hours = nowNY.getHours();
                const minutes = nowNY.getMinutes();
                const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
                
                const isMarketOpen = dayOfWeek !== 0 && dayOfWeek !== 6 && timeStr >= '09:30' && timeStr <= '16:00';
                if (!isMarketOpen) {
                  currentPrice = latestBar.close;
                  const secondLatestBar = localBars[1];
                  prevClose = secondLatestBar ? secondLatestBar.close : null;
                  change = prevClose !== null ? currentPrice - prevClose : null;
                  changePercent = prevClose ? (change! / prevClose) * 100 : null;
                }
              }
            }

            await db.quoteSnapshots.put({
              ...q,
              currentPrice,
              previousClose: prevClose,
              change,
              changePercent,
              requestStatus: 'success'
            } as any);
          }
        });

        // Set matching work items to success
        const returnedKeys = new Set(quotes.map(q => `${q.market}:${q.symbol}`));
        await db.transaction('rw', db.marketWorkItems, async () => {
          for (const itemId of plan.workItemIds) {
            const item = await db.marketWorkItems.get(itemId);
            if (item && item.securityKey && returnedKeys.has(item.securityKey)) {
              await db.marketWorkItems.update(itemId, { status: 'success', updatedAt: now });
            } else if (item) {
              // Not returned - retry
              const attempt = item.attemptCount + 1;
              await db.marketWorkItems.update(itemId, {
                status: attempt >= 5 ? 'failed_permanent' : 'retry_scheduled',
                attemptCount: attempt,
                nextRetryAt: now + 30000,
                lastError: '未返回该标的的行情数据',
                updatedAt: now
              });
            }
          }
        });
      } else {
        // Failed completely
        const errStatus = result.status === 'rate_limited' ? 'paused_quota' : 'retry_scheduled';
        await db.transaction('rw', db.marketWorkItems, async () => {
          for (const itemId of plan.workItemIds) {
            const item = await db.marketWorkItems.get(itemId);
            if (item) {
              const attempt = item.attemptCount + 1;
              const isPerm = attempt >= 5 && errStatus === 'retry_scheduled';
              await db.marketWorkItems.update(itemId, {
                status: isPerm ? 'failed_permanent' : errStatus,
                attemptCount: attempt,
                nextRetryAt: errStatus === 'retry_scheduled' ? now + Math.min(30 * 1000 * Math.pow(2, attempt), 2 * 60 * 60 * 1000) : undefined,
                lastError: result.message || result.errorCode || result.status,
                updatedAt: now
              });
            }
          }
        });
      }
    } else {
      // 2. Handling Historical Bar Sync
      if (result.ok && result.data && Array.isArray(result.data)) {
        const newBars = result.data;
        const mappedBars = newBars.map((bar: any) => {
          const assetTypeMapped = (bar.assetType || 'STOCK').toLowerCase() as any;
          const resolutionMapped = '1d';
          return {
            id: `${bar.market}:${bar.symbol}:${assetTypeMapped}:${resolutionMapped}:${bar.date}`,
            securityKey: `${bar.market}:${bar.symbol}`,
            symbol: bar.symbol,
            market: bar.market,
            assetType: assetTypeMapped,
            resolution: '1d' as const,
            tradeDate: bar.date,
            open: bar.open ?? undefined,
            high: bar.high ?? undefined,
            low: bar.low ?? undefined,
            close: bar.close,
            volume: bar.volume ?? undefined,
            providerId: plan.providerId,
            adjustmentMode: bar.adjustmentMode ?? 'unknown',
            fetchedAt: Date.now(),
            dataQuality: 'normal' as const
          };
        });

        // Save bars
        if (mappedBars.length > 0) {
          await db.transaction('rw', [db.historicalBars, db.quoteSnapshots], async () => {
            for (const b of mappedBars) {
              await db.historicalBars.put(b);
              
              const key = b.securityKey;
              const existingQuote = await db.quoteSnapshots.get(key);
              
              const allSecurityBars = await db.historicalBars
                .where('securityKey')
                .equals(key)
                .toArray();
              
              allSecurityBars.sort((x, y) => y.tradeDate.localeCompare(x.tradeDate));
              const latestBar = allSecurityBars[0];
              
              if (latestBar && latestBar.tradeDate === b.tradeDate) {
                const secondLatestBar = allSecurityBars[1];
                const prevClose = secondLatestBar ? secondLatestBar.close : null;
                const change = prevClose !== null ? latestBar.close - prevClose : null;
                const changePercent = prevClose ? (change! / prevClose) * 100 : null;
                
                await db.quoteSnapshots.put({
                  id: key,
                  symbol: b.symbol,
                  market: b.market,
                  name: existingQuote?.name || b.symbol,
                  assetType: b.assetType.toUpperCase() as any,
                  currentPrice: latestBar.close,
                  previousClose: prevClose,
                  change: change,
                  changePercent: changePercent,
                  currency: b.market === 'US' ? 'USD' : b.market === 'HK' ? 'HKD' : 'CNY',
                  provider: b.providerId,
                  fetchedAt: latestBar.fetchedAt || Date.now(),
                  requestStatus: 'success'
                });
              }
            }
          });
        }

        // An empty successful response is not coverage.  stock-sdk can fall
        // through to MarketData.app; MarketData.app itself becomes a clear
        // terminal "暂不支持" result instead of a misleading completed range.
        if (mappedBars.length === 0) {
          await this.handleHistoricalFailure(plan, result, { noData: true });
          return;
        }

        // Update historicalCoverage
        for (const sec of plan.securities) {
          const fromStr = plan.fromDate || plan.date!;
          const toStr = plan.toDate || plan.date!;
          
          const existingCoverage = await db.historicalCoverage
            .where('securityKey')
            .equals(sec.securityKey)
            .toArray();

          let merged = false;
          for (const cov of existingCoverage) {
            if (cov.resolution === '1d' && cov.providerId === plan.providerId) {
              if (areRangesMergeable(cov.fromDate, cov.toDate, fromStr, toStr)) {
                await db.historicalCoverage.update(cov.id!, {
                  fromDate: cov.fromDate < fromStr ? cov.fromDate : fromStr,
                  toDate: cov.toDate > toStr ? cov.toDate : toStr,
                  coverageStatus: 'complete',
                  updatedAt: now
                });
                merged = true;
                break;
              }
            }
          }

          if (!merged) {
            await db.historicalCoverage.add({
              securityKey: sec.securityKey,
              resolution: '1d',
              fromDate: fromStr,
              toDate: toStr,
              providerId: plan.providerId,
              coverageStatus: 'complete',
              updatedAt: now
            });
          }
        }

        // Mark work items as success.
        await db.transaction('rw', db.marketWorkItems, async () => {
          for (const itemId of plan.workItemIds) {
            await db.marketWorkItems.update(itemId, {
              status: 'success',
              lastError: undefined,
              nextRetryAt: undefined,
              updatedAt: now
            });
          }
        });
      } else {
        await this.handleHistoricalFailure(plan, result);
      }
    }
  }
}
