import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importParsedCandidate } from '../core/imports/nativeInboxService';
import { db } from '../db/localDb';

describe('importParsedCandidate', () => {
  beforeEach(async () => {
    await db.transactions.clear();
    await db.appSettings.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finishes the SHA-256 fingerprint before starting its IndexedDB transaction', async () => {
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return new Uint8Array(32).buffer;
        }),
      },
    });

    const result = await importParsedCandidate({
      id: 'schwab-june-1',
      platform: 'SCHWAB',
      sourceChannel: 'PDF_TEXT',
      externalReference: 'schwab-june-1',
      tradeType: 'BUY',
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      currency: 'USD',
      tradeDate: '2026-06-15',
      tradeTime: '10:00:00',
      price: 200,
      quantity: 1,
      commission: 0,
      tax: 0,
      rawText: 'Schwab monthly statement',
    }, 'Schwab June statement');

    expect(result.status).toBe('IMPORTED');
    expect(await db.transactions.count()).toBe(1);
  });
});
