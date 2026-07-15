import { describe, expect, it } from 'vitest';
import { estimateTradeFees } from '../core/fees/tradeFeeEstimator';

const input = { platform: 'HSBC' as const, market: 'HK' as const, assetType: 'STOCK' as const, tradeType: 'BUY' as const, price: 10, quantity: 100, tradeDate: '2026-07-14', transactions: [] };

describe('trade fee estimator', () => {
  it('applies HSBC standard minimum commission', () => {
    expect(estimateTradeFees({ ...input, planId: 'hsbc_standard' }).commission).toBe(100);
  });

  it('keeps Trade25 commission-free below locally recorded threshold', () => {
    const estimate = estimateTradeFees({ ...input, planId: 'hsbc_trade25' });
    expect(estimate.supported).toBe(true);
    expect(estimate.commission).toBe(0);
  });

  it('calculates uSMART HK commission and platform fee', () => {
    const estimate = estimateTradeFees({ ...input, platform: 'USMART', planId: 'usmart_public_promo', price: 100, quantity: 10 });
    expect(estimate.commission).toBe(12.3);
  });

  it('calculates Longbridge US fixed platform fee', () => {
    const estimate = estimateTradeFees({ ...input, platform: 'LONGBRIDGE', market: 'US', planId: 'longbridge_public_promo', price: 100, quantity: 1000 });
    expect(estimate.supported).toBe(true);
    expect(estimate.commission).toBe(5);
    expect(estimate.ruleId).toBe('longbridge_us_fixed_2026');
  });

  it('calculates Longbridge HK fixed public fees without tiering', () => {
    const estimate = estimateTradeFees({ ...input, platform: 'LONGBRIDGE', market: 'HK', planId: 'longbridge_public_promo', tradeType: 'SELL', price: 10, quantity: 100 });
    expect(estimate.commission).toBe(18);
    expect(estimate.tax).toBe(3.09);
    expect(estimate.ruleId).toBe('longbridge_hk_fixed_2026');
    expect(estimate.warnings[0]).toContain('不考虑账户免佣卡');
  });

  it('calculates East Money HK statutory fees', () => {
    const estimate = estimateTradeFees({ ...input, platform: 'EAST_MONEY', market: 'HK', planId: 'east_money_standard', tradeType: 'SELL' });
    expect(estimate.commission).toBe(15);
    expect(estimate.tax).toBe(6.58);
    expect(estimate.sourceUrl).toContain('eastmoney.com');
  });

  it('applies East Money US low-price fee cap', () => {
    const estimate = estimateTradeFees({ ...input, platform: 'EAST_MONEY', market: 'US', planId: 'east_money_standard', price: 0.35, quantity: 1000 });
    expect(estimate.commission).toBe(3.5);
    expect(estimate.tax).toBe(3);
  });

  it('calculates Zhuorui HK and US public fees', () => {
    const hk = estimateTradeFees({ ...input, platform: 'ZHUORUI', market: 'HK', planId: 'zhuorui_new_customer', tradeType: 'SELL' });
    expect(hk.commission).toBe(15);
    expect(hk.tax).toBe(1.15);
    const us = estimateTradeFees({ ...input, platform: 'ZHUORUI', market: 'US', planId: 'zhuorui_new_customer', tradeType: 'SELL', quantity: 100 });
    expect(us.commission).toBe(1.98);
    expect(us.tax).toBe(0.45);
  });
});
