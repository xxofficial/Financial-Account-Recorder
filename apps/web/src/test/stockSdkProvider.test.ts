import { describe, expect, it } from 'vitest';
import { StockSdkProvider } from '../core/market/stockSdkProvider';

describe('StockSdkProvider security names', () => {
  it('matches stock-sdk US exchange-suffixed search codes', async () => {
    const provider = new StockSdkProvider() as any;
    provider.sdk = () => ({
      search: async () => [{ code: 'usnvo.n', name: '诺和诺德' }],
    });

    await expect(provider.searchSecurity('NVO', 'US', '')).resolves.toMatchObject({
      ok: true,
      data: { symbol: 'NVO', market: 'US', name: '诺和诺德' },
    });
  });
});
