import { db } from '../../db/localDb';
import { MarketWorkItem } from '../../db/schema';

export type MarketWorkItemInput = Omit<MarketWorkItem, 'createdAt' | 'updatedAt' | 'attemptCount'> & {
  status?: MarketWorkItem['status'];
  attemptCount?: number;
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

/**
 * Upsert queue items with advanced merging rules for historical/realtime/daily tasks
 */
export async function upsertMarketWorkItems(inputs: MarketWorkItemInput[]): Promise<void> {
  if (inputs.length === 0) return;

  const now = Date.now();

  await db.transaction('rw', db.marketWorkItems, async () => {
    for (const input of inputs) {
      const status = input.status || 'pending';
      const attemptCount = input.attemptCount || 0;

      // 1. Merge rule for historical_range_fill
      if (input.kind === 'historical_range_fill' && input.securityKey && input.resolution) {
        // Query active historical tasks for this symbol/resolution/reason
        const existingActive = await db.marketWorkItems
          .where('[securityKey+kind]')
          .equals([input.securityKey, 'historical_range_fill'])
          .toArray();

        const activeRangeTasks = existingActive.filter(
          item =>
            item.resolution === input.resolution &&
            item.sourceReason === input.sourceReason &&
            ['pending', 'running', 'paused_quota', 'paused_provider_error', 'retry_scheduled'].includes(item.status)
        );

        let merged = false;
        
        for (const existing of activeRangeTasks) {
          const fromA = existing.requiredFromDate || '';
          const toA = existing.requiredToDate || '';
          const fromB = input.requiredFromDate || '';
          const toB = input.requiredToDate || '';

          if (fromA && toA && fromB && toB && areRangesMergeable(fromA, toA, fromB, toB)) {
            // Merge them!
            const mergedFrom = fromA < fromB ? fromA : fromB;
            const mergedTo = toA > toB ? toA : toB;

            const existingFetchFrom = existing.fetchFromDate || fromA;
            const existingFetchTo = existing.fetchToDate || toA;
            const inputFetchFrom = input.fetchFromDate || fromB;
            const inputFetchTo = input.fetchToDate || toB;

            const mergedFetchFrom = existingFetchFrom < inputFetchFrom ? existingFetchFrom : inputFetchFrom;
            const mergedFetchTo = existingFetchTo > inputFetchTo ? existingFetchTo : inputFetchTo;

            await db.marketWorkItems.update(existing.id, {
              requiredFromDate: mergedFrom,
              requiredToDate: mergedTo,
              fetchFromDate: mergedFetchFrom,
              fetchToDate: mergedFetchTo,
              priority: Math.max(existing.priority, input.priority),
              status: 'pending', // Reset status so it executes again
              updatedAt: now
            });

            merged = true;
            break;
          }
        }

        if (merged) continue;
      }

      // 2. Deduplicate rule for realtime_quote_refresh
      if (input.kind === 'realtime_quote_refresh' && input.securityKey) {
        const existingActive = await db.marketWorkItems
          .where('[securityKey+kind]')
          .equals([input.securityKey, 'realtime_quote_refresh'])
          .toArray();

        const activeRefreshTask = existingActive.find(
          item => ['pending', 'running', 'retry_scheduled'].includes(item.status)
        );

        if (activeRefreshTask) {
          await db.marketWorkItems.update(activeRefreshTask.id, {
            priority: Math.max(activeRefreshTask.priority, input.priority),
            updatedAt: now
          });
          continue;
        }
      }

      // 3. Deduplicate rule for daily_close_update
      if (input.kind === 'daily_close_update' && input.securityKey && input.tradeDate) {
        const existingActive = await db.marketWorkItems
          .where('[securityKey+kind]')
          .equals([input.securityKey, 'daily_close_update'])
          .toArray();

        const activeDailyTask = existingActive.find(
          item => item.tradeDate === input.tradeDate && ['pending', 'running', 'retry_scheduled'].includes(item.status)
        );

        if (activeDailyTask) {
          await db.marketWorkItems.update(activeDailyTask.id, {
            priority: Math.max(activeDailyTask.priority, input.priority),
            updatedAt: now
          });
          continue;
        }
      }

      // Otherwise: Insert new task item
      await db.marketWorkItems.put({
        ...input,
        status,
        attemptCount,
        createdAt: now,
        updatedAt: now
      });
    }
  });
}
