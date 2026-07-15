import { Transaction, TradeType } from '../../db/schema';
export type { TradeType };

// 1. 市场定义 (Market)
export type MarketType = 'A_SHARE' | 'HK' | 'US' | 'CASH';

export interface MarketInfo {
  name: string;
  label: string;
  currencySymbol: string;
  toCnyRate: number;
}

export const Market: Record<MarketType, MarketInfo> = {
  A_SHARE: { name: 'A_SHARE', label: 'A股', currencySymbol: '¥', toCnyRate: 1.0 },
  HK: { name: 'HK', label: '港股', currencySymbol: 'HK$', toCnyRate: 0.92 },
  US: { name: 'US', label: '美股', currencySymbol: '$', toCnyRate: 7.20 },
  CASH: { name: 'CASH', label: '现金', currencySymbol: '¥', toCnyRate: 1.0 }
};

export function getMarketFromString(name: string): MarketInfo | undefined {
  const normalized = name.toUpperCase();
  if (normalized === 'HK' || normalized === 'HONG_KONG') return Market.HK;
  if (normalized === 'A_SHARE' || normalized === 'A') return Market.A_SHARE;
  if (normalized === 'US' || normalized === 'USA') return Market.US;
  if (normalized === 'CASH') return Market.CASH;
  return Market[normalized as MarketType];
}

// 2. 常用货币 (DisplayCurrency)
export type CurrencyType = 'USD' | 'CNY' | 'HKD';

export interface CurrencyInfo {
  code: CurrencyType;
  label: string;
  symbol: string;
  cnyRate: number;
}

export const DisplayCurrency: Record<CurrencyType, CurrencyInfo> = {
  USD: { code: 'USD', label: '美元', symbol: '$', cnyRate: 7.20 },
  CNY: { code: 'CNY', label: '人民币', symbol: '¥', cnyRate: 1.0 },
  HKD: { code: 'HKD', label: '港币', symbol: 'HK$', cnyRate: 0.92 }
};

// 3. 交易/记账类型 (TradeType)
// (Imported and exported above)

export const TradeTypeLabels: Record<TradeType, string> = {
  BUY: '买入',
  SELL: '卖出',
  DEPOSIT: '入金',
  WITHDRAW: '出金',
  TRANSFER_OUT: '转出',
  TRANSFER_IN: '转入',
  INTEREST: '融资利息',
  SPLIT: '拆并股',
  EXPIRE: '期权到期',
  DIVIDEND: '分红',
  TAX: '税费',
  FX_CONVERSION: '货币兑换',
  OTHER: '其他'
};

export function isSecurityTrade(type: TradeType): boolean {
  return type === 'BUY' || type === 'SELL' || type === 'SPLIT' || type === 'EXPIRE';
}

export function isCashFlowPositive(type: TradeType): boolean {
  return (
    type === 'SELL' || 
    type === 'DEPOSIT' || 
    type === 'TRANSFER_IN' || 
    type === 'DIVIDEND' ||
    type === 'OTHER'
  );
}

// 4. 券商平台 (BrokerPlatform)
export type PlatformType = 
  | 'UNSPECIFIED' 
  | 'ALIPAY' 
  | 'EAST_MONEY' 
  | 'LONGBRIDGE' 
  | 'HSBC' 
  | 'USMART' 
  | 'ZHUORUI' 
  | 'CHIEF' 
  | 'SCHWAB';

export interface PlatformInfo {
  code: PlatformType;
  label: string;
  shortLabel: string;
  isConfigurable: boolean;
  supportsPdfImport: boolean;
}

export const BrokerPlatform: Record<PlatformType, PlatformInfo> = {
  UNSPECIFIED: { code: 'UNSPECIFIED', label: '未设置', shortLabel: '未', isConfigurable: false, supportsPdfImport: false },
  ALIPAY: { code: 'ALIPAY', label: '支付宝', shortLabel: '支', isConfigurable: true, supportsPdfImport: false },
  EAST_MONEY: { code: 'EAST_MONEY', label: '东方财富', shortLabel: '东财', isConfigurable: true, supportsPdfImport: false },
  LONGBRIDGE: { code: 'LONGBRIDGE', label: '长桥证券', shortLabel: '长桥', isConfigurable: true, supportsPdfImport: true },
  HSBC: { code: 'HSBC', label: '汇丰银行', shortLabel: 'HS', isConfigurable: true, supportsPdfImport: true },
  USMART: { code: 'USMART', label: 'uSMART', shortLabel: 'uSMART', isConfigurable: true, supportsPdfImport: true },
  ZHUORUI: { code: 'ZHUORUI', label: '卓锐证券', shortLabel: '卓锐', isConfigurable: true, supportsPdfImport: true },
  CHIEF: { code: 'CHIEF', label: '致富证券', shortLabel: '致富', isConfigurable: true, supportsPdfImport: false },
  SCHWAB: { code: 'SCHWAB', label: '嘉信国际', shortLabel: '嘉信', isConfigurable: true, supportsPdfImport: true }
};

export const getConfigurablePlatforms = (): PlatformInfo[] => {
  return Object.values(BrokerPlatform).filter(p => p.isConfigurable);
};

// 5. UI 展现模型 (TransactionUiModel)
export interface TransactionUiModel {
  id: number;
  tradeType: TradeType;
  stockName: string;
  primaryMeta: string;
  secondaryMeta: string | null;
  amountLabel: string;
  timeLabel: string;
  feeLabel: string;
  platform: PlatformType;
  platformLabel: string;
  displayTypeLabel: string;
  title: string;
  metaLabel: string;
  detailParts: string[];
  amountTone: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
}

// 6. 数据库实体 -> UI 模型的转换函数
export function mapTransactionToUiModel(txn: Transaction): TransactionUiModel {
  const id = txn.id || 0;
  const tradeType = txn.tradeType as TradeType;
  const stockName = txn.name || txn.symbol;
  
  // 1. 生成元数据标签
  let primaryMeta = '';
  if (isSecurityTrade(tradeType)) {
    primaryMeta = `${txn.quantity} 股 @ ${txn.price.toFixed(2)}`;
  } else {
    primaryMeta = txn.note || TradeTypeLabels[tradeType];
  }

  let secondaryMeta: string | null = null;
  if (txn.assetType === 'OPTION') {
    const typeLabel = txn.optionType === 'CALL' ? '看涨' : txn.optionType === 'PUT' ? '看跌' : '';
    secondaryMeta = `${typeLabel}期权 | 行权价: ${txn.strikePrice?.toFixed(2)} | 到期: ${txn.expiryDate}`;
  } else if (tradeType === 'FX_CONVERSION') {
    secondaryMeta = `兑换: ${txn.fxFromAmount} ${txn.fxFromCurrency} -> ${txn.fxToAmount} ${txn.fxToCurrency} (汇率: ${txn.fxRate})`;
  }

  // 2. 计算交易的现金流影响金额
  let cashImpact = 0;
  if (tradeType === 'BUY') {
    // 买入：支出 = 股数 * 价格 + 佣金 + 印花税
    cashImpact = -(txn.quantity * txn.price + txn.commission + txn.tax);
  } else if (tradeType === 'SELL') {
    // 卖出：收入 = 股数 * 价格 - 佣金 - 印花税
    cashImpact = txn.quantity * txn.price - txn.commission - txn.tax;
  } else if (tradeType === 'DEPOSIT' || tradeType === 'TRANSFER_IN' || tradeType === 'DIVIDEND') {
    cashImpact = txn.price; // 存入、转入、分红：价格项代表金额
  } else if (tradeType === 'WITHDRAW' || tradeType === 'TRANSFER_OUT' || tradeType === 'INTEREST' || tradeType === 'TAX') {
    cashImpact = -txn.price; // 提取、转出、融资利息、单独税费：价格项代表金额
  } else if (tradeType === 'OTHER') {
    cashImpact = txn.price; // 其他：正负由价格正负决定
  }

  // 3. 生成金额与色调标签
  const mkt = Market[txn.market] || Market.CASH;
  const symbolStr = mkt.currencySymbol;
  
  let amountLabel = '';
  let amountTone: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' = 'NEUTRAL';

  if (cashImpact > 0) {
    amountLabel = `+${symbolStr}${cashImpact.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    amountTone = 'POSITIVE';
  } else if (cashImpact < 0) {
    amountLabel = `-${symbolStr}${Math.abs(cashImpact).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    amountTone = 'NEGATIVE';
  } else {
    amountLabel = `${symbolStr}0.00`;
    amountTone = 'NEUTRAL';
  }

  // 4. 时间标签 (格式：YYYY-MM-DD HH:mm)
  const timeLabel = `${txn.tradeDate} ${txn.tradeTime.substring(0, 5)}`;

  // 5. 费用标签
  const totalFees = txn.commission + txn.tax;
  const feeLabel = totalFees > 0 ? `费用: ${symbolStr}${totalFees.toFixed(2)}` : '免手续费';

  // 6. 券商平台信息
  const plat = BrokerPlatform[txn.platform as PlatformType] || BrokerPlatform.UNSPECIFIED;

  // 7. 详细段落明细列表
  const detailParts: string[] = [];
  detailParts.push(`交易类型: ${TradeTypeLabels[tradeType]}`);
  detailParts.push(`市场/代码: ${txn.market} / ${txn.symbol}`);
  detailParts.push(`平台: ${plat.label}`);
  if (isSecurityTrade(tradeType)) {
    detailParts.push(`成交价格: ${symbolStr}${txn.price.toFixed(4)}`);
    detailParts.push(`成交数量: ${txn.quantity} 股`);
  }
  if (txn.commission > 0) detailParts.push(`佣金费用: ${symbolStr}${txn.commission.toFixed(2)}`);
  if (txn.tax > 0) detailParts.push(`政府印花/规税: ${symbolStr}${txn.tax.toFixed(2)}`);
  if (txn.note) detailParts.push(`交易备注: ${txn.note}`);

  return {
    id,
    tradeType,
    stockName,
    primaryMeta,
    secondaryMeta,
    amountLabel,
    timeLabel,
    feeLabel,
    platform: txn.platform as PlatformType,
    platformLabel: plat.shortLabel,
    displayTypeLabel: TradeTypeLabels[tradeType],
    title: stockName,
    metaLabel: primaryMeta,
    detailParts,
    amountTone,
  };
}
