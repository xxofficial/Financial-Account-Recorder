import type { Transaction } from '../../db/schema';
import type { MarketType, PlatformType, TradeType } from '../../shared/models';

export interface FeeEstimateInput {
  platform: PlatformType;
  planId?: string;
  market: MarketType;
  assetType: 'STOCK' | 'OPTION';
  tradeType: TradeType;
  price: number;
  quantity: number;
  tradeDate: string;
  transactions: Transaction[];
}

export interface FeeEstimate {
  supported: boolean;
  commission: number;
  tax: number;
  lines: Array<{ label: string; amount: number; bucket: 'commission' | 'tax' }>;
  warnings: string[];
  ruleId?: string;
  sourceUrl?: string;
}

export const FEE_RULE_SOURCES = {
  eastMoney: 'https://zqhd.eastmoney.com/Html/aghd/native/6/20180815/html/share.html',
  longbridgeRate: 'https://longbridge.com/hk/en/rate',
  longbridgeHongKong: 'https://longbridge.com/hk/support/topics/hkmarket/rpop8q',
  longbridgeUs: 'https://longbridge.com/hk/en/investment-products/trade-us-stocks',
  longbridgeOptions: 'https://longbridge.com/hk/en/investment-products/trade-options',
  zhuorui: 'https://www.zr.hk/feesDetails/',
} as const;

const round = (value: number) => Math.round(value * 100) / 100;
const gross = (input: FeeEstimateInput) => input.price * input.quantity * (input.assetType === 'OPTION' ? 100 : 1);
const unsupported = (message: string): FeeEstimate => ({ supported: false, commission: 0, tax: 0, lines: [], warnings: [message] });
const estimated = (lines: FeeEstimate['lines'], warnings: string[] = [], metadata?: Pick<FeeEstimate, 'ruleId' | 'sourceUrl'>): FeeEstimate => ({
  supported: true,
  commission: round(lines.filter((line) => line.bucket === 'commission').reduce((total, line) => total + line.amount, 0)),
  tax: round(lines.filter((line) => line.bucket === 'tax').reduce((total, line) => total + line.amount, 0)),
  lines: lines.map((line) => ({ ...line, amount: round(line.amount) })),
  warnings,
  ...metadata,
});

function hkdEquivalent(transaction: Pick<Transaction, 'market' | 'price' | 'quantity' | 'assetType'>): number {
  const multiplier = transaction.assetType === 'OPTION' ? 100 : 1;
  const value = transaction.price * transaction.quantity * multiplier;
  if (transaction.market === 'US') return value * 7.2 / 0.92;
  if (transaction.market === 'A_SHARE' || transaction.market === 'CASH') return value / 0.92;
  return value;
}

function hsbcStandard(input: FeeEstimateInput): FeeEstimate {
  const value = gross(input);
  if (input.market === 'HK') return estimated([{ label: '汇丰网上交易佣金', amount: Math.max(value * 0.0025, 100), bucket: 'commission' }], ['未估算港交所及监管代收费用。']);
  if (input.market === 'US') return estimated([{ label: '汇丰美股网上交易佣金', amount: input.quantity <= 1000 ? 18 : 18 + (input.quantity - 1000) * 0.015, bucket: 'commission' }], ['未估算美国监管及交易所代收费用。']);
  if (input.market === 'A_SHARE') return estimated([{ label: '汇丰中国 A 股网上交易佣金', amount: Math.max(value * 0.0025, 100), bucket: 'commission' }], ['未估算交易所及监管代收费用。']);
  return unsupported('该市场不适用汇丰证券费用估算。');
}

function hsbcTrade25(input: FeeEstimateInput): FeeEstimate {
  const month = input.tradeDate.slice(0, 7);
  const turnover = input.transactions
    .filter((transaction) => transaction.platform === 'HSBC' && ['BUY', 'SELL'].includes(transaction.tradeType) && transaction.tradeDate.startsWith(month))
    .reduce((total, transaction) => total + hkdEquivalent(transaction), 0) + hkdEquivalent({ ...input, market: input.market });
  if (turnover <= 250_000) return estimated([], ['Trade25 月费、托管费及市场代收费用不摊入单笔交易。月累计成交额仅按本地账本记录估算。']);
  const standard = hsbcStandard(input);
  return { ...standard, warnings: [...standard.warnings, '本地账本推算当月累计成交额超过 HKD 250,000，已按标准佣金估算。'] };
}

function eastMoneyHongKong(input: FeeEstimateInput): FeeEstimate {
  const value = gross(input);
  const stampDuty = input.tradeType === 'SELL' ? Math.max(value * 0.001, 1) : 0;
  const levy = Math.max(value * 0.000027, 0.01);
  const tradingFee = Math.max(value * 0.00005, 0.01);
  const settlement = Math.min(Math.max(value * 0.00005, 5.5), 200);
  return estimated([
    { label: '东方财富港股佣金', amount: 0, bucket: 'commission' },
    { label: '东方财富港股平台使用费', amount: 15, bucket: 'commission' },
    ...(stampDuty ? [{ label: '港股印花税（卖出）', amount: stampDuty, bucket: 'tax' as const }] : []),
    { label: '港股交易征费', amount: levy, bucket: 'tax' },
    { label: '港股交易费', amount: tradingFee, bucket: 'tax' },
    { label: '港股结算费', amount: settlement, bucket: 'tax' },
  ], [], { ruleId: 'east_money_hk_public_2026', sourceUrl: FEE_RULE_SOURCES.eastMoney });
}

function eastMoneyUs(input: FeeEstimateInput): FeeEstimate {
  const value = gross(input);
  const commission = Math.max(input.quantity * 0.0049, 0.99);
  const platformFee = Math.max(input.quantity * 0.005, 1);
  const cappedCommission = input.price < 1 && commission + platformFee > 1.99
    ? Math.min(commission + platformFee, value * 0.01)
    : commission + platformFee;
  const settlement = Math.max(input.quantity * 0.003, 0.01);
  const secFee = input.tradeType === 'SELL' ? Math.max(value * 0.0000207, 0.01) : 0;
  const activityFee = input.tradeType === 'SELL' ? Math.min(Math.max(input.quantity * 0.000119, 0.01), 5.95) : 0;
  return estimated([
    { label: '东方财富美股佣金及平台费', amount: cappedCommission, bucket: 'commission' },
    { label: '美股结算费', amount: settlement, bucket: 'tax' },
    ...(secFee ? [{ label: '美国证监会规费（卖出）', amount: secFee, bucket: 'tax' as const }] : []),
    ...(activityFee ? [{ label: 'FINRA 交易活动费（卖出）', amount: activityFee, bucket: 'tax' as const }] : []),
  ], [], { ruleId: 'east_money_us_public_2026', sourceUrl: FEE_RULE_SOURCES.eastMoney });
}

function longbridgeUsStock(input: FeeEstimateInput): FeeEstimate {
  const platformFee = Math.max(input.quantity * 0.005, 1);
  return estimated([
    { label: '长桥美股佣金', amount: 0, bucket: 'commission' },
    { label: '长桥美股固定平台费', amount: platformFee, bucket: 'commission' },
  ], ['未估算美国监管及交易所代收费用。'], { ruleId: 'longbridge_us_fixed_2026', sourceUrl: FEE_RULE_SOURCES.longbridgeUs });
}

function longbridgeHongKong(input: FeeEstimateInput): FeeEstimate {
  const value = gross(input);
  const stampDuty = Math.ceil(value * 0.001);
  const clearingFee = Math.min(Math.max(value * 0.00002, 2), 100);
  return estimated([
    { label: '长桥港股固定佣金', amount: Math.max(value * 0.0003, 3), bucket: 'commission' },
    { label: '长桥港股平台费', amount: 15, bucket: 'commission' },
    { label: '港股结算费', amount: clearingFee, bucket: 'tax' },
    { label: '港股印花税', amount: stampDuty, bucket: 'tax' },
    { label: '港股交易费', amount: Math.max(value * 0.0000565, 0.01), bucket: 'tax' },
    { label: '港股交易征费', amount: Math.max(value * 0.000027, 0.01), bucket: 'tax' },
    { label: '会财局交易征费', amount: Math.max(value * 0.0000015, 0.01), bucket: 'tax' },
  ], ['按长桥官网固定公开示例估算，不考虑账户免佣卡或阶梯/活动优惠。'], { ruleId: 'longbridge_hk_fixed_2026', sourceUrl: FEE_RULE_SOURCES.longbridgeHongKong });
}

function longbridgeUsOption(input: FeeEstimateInput): FeeEstimate {
  const commissionRate = input.price > 0.1 ? 0.45 : 0.1;
  const commissionMinimum = input.price > 0.1 ? 1.49 : 0.99;
  return estimated([
    { label: '长桥美股期权佣金', amount: Math.max(input.quantity * commissionRate, commissionMinimum), bucket: 'commission' },
    { label: '长桥美股期权固定平台费', amount: input.quantity * 0.3, bucket: 'commission' },
  ], ['未估算美股期权监管、清算及交易活动费。'], { ruleId: 'longbridge_us_options_fixed_2026', sourceUrl: FEE_RULE_SOURCES.longbridgeOptions });
}

function zhuoruiHongKong(input: FeeEstimateInput): FeeEstimate {
  const value = gross(input);
  const stampDuty = input.tradeType === 'SELL' ? Math.max(value * 0.001, 1) : 0;
  return estimated([
    { label: '卓锐港股在线佣金', amount: Math.max(value * 0.0003, 3), bucket: 'commission' },
    { label: '卓锐港股平台费', amount: 12, bucket: 'commission' },
    ...(stampDuty ? [{ label: '港股印花税（卖出）', amount: stampDuty, bucket: 'tax' as const }] : []),
    { label: '港股交易征费', amount: Math.max(value * 0.000027, 0.01), bucket: 'tax' },
    { label: '港股交易费', amount: Math.max(value * 0.0000565, 0.01), bucket: 'tax' },
    { label: '港股结算费', amount: Math.max(value * 0.000052, 0.01), bucket: 'tax' },
    { label: '会财局交易征费', amount: Math.max(value * 0.0000015, 0.01), bucket: 'tax' },
  ], [], { ruleId: 'zhuorui_hk_new_customer_2026', sourceUrl: FEE_RULE_SOURCES.zhuorui });
}

function zhuoruiUsStock(input: FeeEstimateInput): FeeEstimate {
  const value = gross(input);
  const secFee = input.tradeType === 'SELL' ? Math.max(value * 0.0000206, 0.01) : 0;
  const activityFee = input.tradeType === 'SELL' ? Math.min(Math.max(input.quantity * 0.000195, 0.01), 9.79) : 0;
  return estimated([
    { label: '卓锐美股在线佣金', amount: Math.max(input.quantity * 0.0049, 0.99), bucket: 'commission' },
    { label: '卓锐美股平台费', amount: Math.max(input.quantity * 0.0049, 0.99), bucket: 'commission' },
    { label: '美股清算费', amount: Math.max(input.quantity * 0.003, 0.4), bucket: 'tax' },
    ...(secFee ? [{ label: '美国证监会规费（卖出）', amount: secFee, bucket: 'tax' as const }] : []),
    ...(activityFee ? [{ label: 'FINRA 交易活动费（卖出）', amount: activityFee, bucket: 'tax' as const }] : []),
    { label: 'FINRA CAT 费用', amount: Math.max(input.quantity * 0.000003, 0.01), bucket: 'tax' },
  ], [], { ruleId: 'zhuorui_us_new_customer_2026', sourceUrl: FEE_RULE_SOURCES.zhuorui });
}

export function estimateTradeFees(input: FeeEstimateInput): FeeEstimate {
  if (!['BUY', 'SELL'].includes(input.tradeType)) return unsupported('仅支持买入和卖出交易的费用估算。');
  if (!Number.isFinite(input.price) || !Number.isFinite(input.quantity) || input.price <= 0 || input.quantity <= 0) return unsupported('请先填写有效的成交价格和数量。');
  const planId = input.planId ?? ({ EAST_MONEY: 'east_money_standard', LONGBRIDGE: 'longbridge_public_promo', HSBC: 'hsbc_standard', USMART: 'usmart_public_promo', ZHUORUI: 'zhuorui_new_customer', CHIEF: 'chief_online_standard', SCHWAB: 'schwab_us_online' } as Partial<Record<PlatformType, string>>)[input.platform];
  if (planId === 'hsbc_standard') return hsbcStandard(input);
  if (planId === 'hsbc_trade25') return hsbcTrade25(input);
  if (planId === 'east_money_standard' && input.assetType === 'STOCK' && input.market === 'HK') return eastMoneyHongKong(input);
  if (planId === 'east_money_standard' && input.assetType === 'STOCK' && input.market === 'US') return eastMoneyUs(input);
  if (planId === 'longbridge_public_promo' && input.market === 'HK' && input.assetType === 'STOCK') return longbridgeHongKong(input);
  if (planId === 'longbridge_public_promo' && input.market === 'US' && input.assetType === 'STOCK') return longbridgeUsStock(input);
  if (planId === 'longbridge_public_promo' && input.market === 'US' && input.assetType === 'OPTION') return longbridgeUsOption(input);
  if (planId === 'usmart_public_promo' && input.market === 'HK' && input.assetType === 'STOCK') {
    return estimated([
      { label: 'uSMART 港股佣金', amount: gross(input) * 0.0003, bucket: 'commission' },
      { label: 'uSMART 港股平台使用费', amount: 12, bucket: 'commission' },
    ], ['未估算港交所及监管代收费用。']);
  }
  if (planId === 'zhuorui_new_customer' && input.market === 'HK' && input.assetType === 'STOCK') return zhuoruiHongKong(input);
  if (planId === 'zhuorui_new_customer' && input.market === 'US' && input.assetType === 'STOCK') return zhuoruiUsStock(input);
  if (planId === 'chief_online_standard' && input.market === 'US' && input.assetType === 'STOCK') {
    return estimated([{ label: '致富美股网上交易佣金', amount: Math.max(input.quantity * 0.01, 2.88), bucket: 'commission' }], ['未估算卖出监管及交易所代收费用。']);
  }
  if (planId === 'schwab_us_online' && input.market === 'US' && input.assetType === 'STOCK') {
    return estimated([], ['嘉信美股网上交易佣金按公开口径为零；未估算卖出监管及交易所代收费用。']);
  }
  return unsupported('当前费率方案或品种缺少可核验的完整规则，请手工填写费用。');
}
