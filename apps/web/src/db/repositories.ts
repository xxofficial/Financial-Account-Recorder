import { db } from './localDb';
import { 
  Ledger, 
  Transaction, 
  QuoteSnapshot, 
  HistoricalDailyBar, 
  MarketProviderConfig 
} from './schema';

export class LedgerRepository {
  async get(id: number): Promise<Ledger | undefined> {
    return db.ledgers.get(id);
  }

  async list(): Promise<Ledger[]> {
    return db.ledgers.toArray();
  }

  async create(ledger: Omit<Ledger, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const now = Date.now();
    return db.ledgers.add({
      ...ledger,
      createdAt: now,
      updatedAt: now,
    });
  }

  async update(id: number, updates: Partial<Omit<Ledger, 'id' | 'createdAt'>>): Promise<number> {
    const count = await db.ledgers.update(id, {
      ...updates,
      updatedAt: Date.now(),
    });
    return count;
  }

  async delete(id: number): Promise<void> {
    await db.transaction('rw', [db.ledgers, db.transactions], async () => {
      await db.ledgers.delete(id);
      // Cascade delete transactions associated with this ledger
      await db.transactions.where('ledgerId').equals(id).delete();
    });
  }
}

export class TransactionRepository {
  async get(id: number): Promise<Transaction | undefined> {
    return db.transactions.get(id);
  }

  async create(transaction: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>): Promise<number> {
    const now = Date.now();
    return db.transactions.add({
      ...transaction,
      createdAt: now,
      updatedAt: now,
    } as Transaction);
  }

  async update(id: number, updates: Partial<Omit<Transaction, 'id' | 'createdAt'>>): Promise<number> {
    const count = await db.transactions.update(id, {
      ...updates,
      updatedAt: Date.now(),
    });
    return count;
  }

  async delete(id: number): Promise<void> {
    await db.transactions.delete(id);
  }

  async listByLedger(ledgerId: number): Promise<Transaction[]> {
    return db.transactions
      .where('ledgerId')
      .equals(ledgerId)
      .sortBy('tradeDate');
  }

  async searchAndFilter(params: {
    ledgerId?: number;
    keyword?: string;
    market?: string;
    platform?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<Transaction[]> {
    let collection = db.transactions.toCollection();

    // Index-friendly filtering if ledgerId is present
    if (params.ledgerId !== undefined) {
      collection = db.transactions.where('ledgerId').equals(params.ledgerId);
    }

    let results = await collection.toArray();

    // Sort by tradeDate descending, then tradeTime descending
    results.sort((a, b) => {
      if (a.tradeDate !== b.tradeDate) {
        return b.tradeDate.localeCompare(a.tradeDate);
      }
      return b.tradeTime.localeCompare(a.tradeTime);
    });

    // In-memory filters (since IndexedDB lacks advanced search indexes)
    if (params.keyword) {
      const kw = params.keyword.toLowerCase();
      results = results.filter(
        t => 
          t.symbol.toLowerCase().includes(kw) || 
          t.name.toLowerCase().includes(kw) || 
          (t.note && t.note.toLowerCase().includes(kw))
      );
    }

    if (params.market) {
      results = results.filter(t => t.market === params.market);
    }

    if (params.platform) {
      results = results.filter(t => t.platform === params.platform);
    }

    if (params.startDate) {
      results = results.filter(t => t.tradeDate >= params.startDate!);
    }

    if (params.endDate) {
      results = results.filter(t => t.tradeDate <= params.endDate!);
    }

    return results;
  }
}

export class QuoteSnapshotRepository {
  async get(market: string, symbol: string): Promise<QuoteSnapshot | undefined> {
    const id = `${market}:${symbol}`;
    return db.quoteSnapshots.get(id);
  }

  async list(): Promise<QuoteSnapshot[]> {
    return db.quoteSnapshots.toArray();
  }

  async upsert(snapshot: Omit<QuoteSnapshot, 'id' | 'fetchedAt'>): Promise<string> {
    const id = `${snapshot.market}:${snapshot.symbol}`;
    const now = Date.now();
    await db.quoteSnapshots.put({
      ...snapshot,
      id,
      fetchedAt: now,
    });
    return id;
  }

  async bulkUpsert(snapshots: Omit<QuoteSnapshot, 'id' | 'fetchedAt'>[]): Promise<void> {
    const now = Date.now();
    const rows = snapshots.map(s => ({
      ...s,
      id: `${s.market}:${s.symbol}`,
      fetchedAt: now,
    }));
    await db.quoteSnapshots.bulkPut(rows);
  }

  async delete(market: string, symbol: string): Promise<void> {
    const id = `${market}:${symbol}`;
    await db.quoteSnapshots.delete(id);
  }
}

export class HistoricalDailyBarRepository {
  async getRange(
    market: string,
    symbol: string,
    assetType: 'STOCK' | 'OPTION',
    startDate: string,
    endDate: string
  ): Promise<HistoricalDailyBar[]> {
    // Look up via primary key string prefix pattern or simple query filters
    return db.historicalDailyBars
      .where('symbol')
      .equals(symbol)
      .filter(bar => 
        bar.market === market && 
        bar.assetType === assetType && 
        bar.date >= startDate && 
        bar.date <= endDate
      )
      .sortBy('date');
  }

  async bulkUpsert(bars: Omit<HistoricalDailyBar, 'id' | 'fetchedAt'>[]): Promise<void> {
    const now = Date.now();
    const rows = bars.map(bar => ({
      ...bar,
      id: `${bar.market}:${bar.symbol}:${bar.assetType}:${bar.date}`,
      fetchedAt: now,
    }));
    await db.historicalDailyBars.bulkPut(rows);
  }

  async clear(): Promise<void> {
    await db.historicalDailyBars.clear();
  }
}

export class MarketProviderConfigRepository {
  async get(provider: 'itick' | 'twelvedata' | 'marketdata'): Promise<MarketProviderConfig | undefined> {
    return db.marketProviderConfigs.get(provider);
  }

  async list(): Promise<MarketProviderConfig[]> {
    return db.marketProviderConfigs.orderBy('priority').toArray();
  }

  async update(provider: 'itick' | 'twelvedata' | 'marketdata', updates: Partial<Omit<MarketProviderConfig, 'provider' | 'createdAt'>>): Promise<number> {
    return db.marketProviderConfigs.update(provider, {
      ...updates,
      updatedAt: Date.now(),
    });
  }
}

export class AppSettingRepository {
  async get(key: string): Promise<any> {
    const entry = await db.appSettings.get(key);
    return entry ? entry.value : undefined;
  }

  async set(key: string, value: any): Promise<void> {
    await db.appSettings.put({
      key,
      value,
      updatedAt: Date.now(),
    });
  }

  async delete(key: string): Promise<void> {
    await db.appSettings.delete(key);
  }
}
