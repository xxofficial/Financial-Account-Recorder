import { Transaction, QuoteSnapshot } from '../../db/schema';
import { MarketType, TradeType } from '../../shared/models';

// 1. 汇率数据接口定义
export interface ExchangeRates {
  usdToCny: number;
  hkdToCny: number;
  updatedAtMillis?: number | null;
}

// 2. 汇率转人民币换算辅助函数
export function rateToCny(rates: ExchangeRates, market: MarketType): number {
  switch (market) {
    case 'A_SHARE':
    case 'CASH':
      return 1.0;
    case 'HK':
      return rates.hkdToCny;
    case 'US':
      return rates.usdToCny;
    default:
      return 1.0;
  }
}

export function convertToCny(value: number, market: MarketType, exchangeRates: ExchangeRates): number {
  return value * rateToCny(exchangeRates, market);
}

/** User-entered quantities use a 0.0001 step across the Web and Android apps. */
export const QUANTITY_DECIMAL_PLACES = 4;

export function normalizeQuantity(value: number): number {
  const scale = 10 ** QUANTITY_DECIMAL_PLACES;
  const normalized = Math.round((value + Number.EPSILON) * scale) / scale;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function formatQuantity(value: number): string {
  return normalizeQuantity(value).toFixed(QUANTITY_DECIMAL_PLACES).replace(/\.?(0+)$/, '');
}

// 3. 平台证券辅助规则 (PortfolioSecurityRules)
export const PortfolioSecurityRules = {
  US_TIMEZONE_CUTOFF: '06:00',

  isOptionAsset(assetType: string | null | undefined, symbol: string): boolean {
    return (
      assetType?.toUpperCase() === 'OPTION' || 
      this.isOptionSymbol(symbol)
    );
  },

  optionMultiplier(assetType: string | null | undefined, symbol: string): number {
    return this.isOptionAsset(assetType, symbol) ? 100.0 : 1.0;
  },

  positionKey(symbol: string, market: MarketType): string {
    return `${market}:${symbol}`;
  },

  attributionSymbol(symbol: string, assetType: string | null | undefined, underlyingSymbol: string | null | undefined): string {
    if (this.isOptionAsset(assetType, symbol)) {
      // Legacy Android/backup records can carry an Eastmoney-style US suffix
      // (for example, `ST.US`) even though market is stored separately.  Keep
      // the canonical Web identity as `ST` + `US`, so option attribution,
      // navigation and stock-detail cache lookups all resolve to the same key.
      return (underlyingSymbol?.trim() || symbol.split(' ')[0] || symbol)
        .replace(/\.US$/i, '')
        .toUpperCase();
    }
    return symbol;
  },

  attributionKey(symbol: string, market: MarketType, assetType: string | null | undefined, underlyingSymbol: string | null | undefined): string {
    return this.positionKey(this.attributionSymbol(symbol, assetType, underlyingSymbol), market);
  },

  splitEventKey(market: MarketType, symbol: string, tradeDate: string, ratio: number): string {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const normalizedRatio = Math.round(ratio * 1000000000.0) / 1000000000.0;
    return `${market}:${normalizedSymbol}:${tradeDate}:${normalizedRatio}`;
  },

  effectiveTradeDate(tradeDate: string, tradeTime: string, market: MarketType, tradeType: TradeType): string {
    if (tradeType === 'SPLIT') return tradeDate;
    
    // 美股 06:00 前的交易（夏夜盘/美股夏冬令时夜盘）在业务上归属于前一个交易日
    if (market === 'US' && tradeTime.substring(0, 5) < this.US_TIMEZONE_CUTOFF) {
      const date = new Date(tradeDate + 'T00:00:00Z');
      date.setUTCDate(date.getUTCDate() - 1);
      return date.toISOString().split('T')[0];
    }
    return tradeDate;
  },

  isOptionSymbol(symbol: string): boolean {
    const parts = symbol.trim().split(/\s+/);
    if (parts.length !== 2) return false;
    const optPart = parts[1];
    if (optPart.length < 8) return false;
    const datePart = optPart.substring(0, 6);
    if (!/^\d+$/.test(datePart)) return false;
    const typeChar = optPart.charAt(6);
    return typeChar === 'C' || typeChar === 'P';
  }
};

// 4. 持仓明细与计算快照接口 (PortfolioPosition / PortfolioSnapshot)
export interface PortfolioPosition {
  symbol: string;
  name: string;
  market: MarketType;
  quantity: number;
  averageCost: number;
  remainingCost: number;
  realizedProfit: number;
  assetType: 'STOCK' | 'OPTION';
  underlyingSymbol: string | null;
}

export interface PortfolioSnapshot {
  positions: Record<string, PortfolioPosition>;
  totalAssetsCny: number;
  holdingsValueCny: number;
  cashBalanceCny: number;
  totalDepositCny: number;
  totalWithdrawCny: number;
  netInflowCny: number;
  unrealizedProfitCny: number;
  unrealizedProfitPercent: number;
  dayProfitCny: number;
  dayProfitPercent: number;
  totalCommissionCny: number;
  totalTaxCny: number;
  securityTradeCount: number;
  buyTradeCount: number;
  sellTradeCount: number;
}

function completeTransferGroupIds(transactions: Transaction[]): string[] {
  const groups = new Map<string, { incoming: number; outgoing: number }>();
  transactions.forEach((transaction) => {
    if (!transaction.transferGroupId) return;
    const group = groups.get(transaction.transferGroupId) ?? { incoming: 0, outgoing: 0 };
    if (transaction.tradeType === 'TRANSFER_IN') group.incoming += 1;
    if (transaction.tradeType === 'TRANSFER_OUT') group.outgoing += 1;
    groups.set(transaction.transferGroupId, group);
  });
  return [...groups.entries()]
    .filter(([, group]) => group.incoming === 1 && group.outgoing === 1)
    .map(([groupId]) => groupId);
}

// 5. 核心计算类 (PortfolioCalculator)
export class PortfolioCalculator {
  calculate(
    transactions: Transaction[],
    quotes: QuoteSnapshot[],
    exchangeRates: ExchangeRates
  ): PortfolioSnapshot {
    const positions: Record<string, PortfolioPosition> = {};
    let cashBalanceCny = 0.0;
    let totalDepositCny = 0.0;
    let totalWithdrawCny = 0.0;
    let totalCommissionCny = 0.0;
    let totalTaxCny = 0.0;
    let securityTradeCount = 0;
    let buyTradeCount = 0;
    let sellTradeCount = 0;
    const appliedSplitEvents = new Set<string>();
    const completeTransferGroups = new Set(completeTransferGroupIds(transactions));

    // 排序逻辑：有效交易日期升序 -> 交易时间升序 -> 创建时间升序
    const sortedTrades = [...transactions].sort((a, b) => {
      const dateA = PortfolioSecurityRules.effectiveTradeDate(a.tradeDate, a.tradeTime, a.market, a.tradeType as TradeType);
      const dateB = PortfolioSecurityRules.effectiveTradeDate(b.tradeDate, b.tradeTime, b.market, b.tradeType as TradeType);
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      if (a.tradeTime !== b.tradeTime) return a.tradeTime.localeCompare(b.tradeTime);
      return a.createdAt - b.createdAt;
    });

    sortedTrades.forEach((transaction) => {
      const tradeType = transaction.tradeType as TradeType;
      const mult = PortfolioSecurityRules.optionMultiplier(transaction.assetType, transaction.symbol);

      switch (tradeType) {
        case 'DEPOSIT': {
          const amountCny = convertToCny(transaction.price * transaction.quantity * mult, transaction.market, exchangeRates);
          if (transaction.market === 'CASH' || transaction.symbol === 'CASH') {
            cashBalanceCny += amountCny;
          } else {
            const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
            const current = positions[key] || this.createEmptyPosition(transaction);
            
            const nextQuantity = this.cleanQuantity(current.quantity + transaction.quantity);
            const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost + (transaction.price * transaction.quantity * mult);
            
            positions[key] = {
              ...current,
              quantity: nextQuantity,
              remainingCost: nextRemaining,
              averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult)
            };
          }
          totalDepositCny += amountCny;
          break;
        }

        case 'WITHDRAW': {
          const amountCny = convertToCny(transaction.price * transaction.quantity * mult, transaction.market, exchangeRates);
          if (transaction.market === 'CASH' || transaction.symbol === 'CASH') {
            cashBalanceCny -= amountCny;
          } else {
            const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
            const current = positions[key];
            if (current) {
              const nextQuantity = this.cleanQuantity(current.quantity - transaction.quantity);
              const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost - (transaction.price * transaction.quantity * mult);
              
              positions[key] = {
                ...current,
                quantity: nextQuantity,
                remainingCost: nextRemaining,
                averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult)
              };
            }
          }
          totalWithdrawCny += amountCny;
          break;
        }

        case 'INTEREST': {
          const amountCny = convertToCny(Math.abs(transaction.price * transaction.quantity), transaction.market, exchangeRates);
          cashBalanceCny -= amountCny;
          break;
        }

        case 'BUY':
        case 'SELL': {
          totalCommissionCny += convertToCny(transaction.commission, transaction.market, exchangeRates);
          totalTaxCny += convertToCny(transaction.tax, transaction.market, exchangeRates);
          securityTradeCount += 1;
          if (tradeType === 'BUY') buyTradeCount++; else sellTradeCount++;
          
          cashBalanceCny += this.applySecurityTrade(transaction, positions, exchangeRates);
          break;
        }

        case 'EXPIRE': {
          this.applyExpire(transaction, positions);
          break;
        }

        case 'TRANSFER_IN': {
          const amountCny = convertToCny(transaction.price * transaction.quantity * mult, transaction.market, exchangeRates);
          if (transaction.market === 'CASH' || transaction.symbol === 'CASH') {
            cashBalanceCny += amountCny;
          } else {
            const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
            const current = positions[key] || this.createEmptyPosition(transaction);
            
            const nextQuantity = this.cleanQuantity(current.quantity + transaction.quantity);
            const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost + (transaction.price * transaction.quantity * mult);
            
            positions[key] = {
              ...current,
              quantity: nextQuantity,
              remainingCost: nextRemaining,
              averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult)
            };
          }
          if (!transaction.transferGroupId || !completeTransferGroups.has(transaction.transferGroupId)) totalDepositCny += amountCny;
          break;
        }

        case 'TRANSFER_OUT': {
          const amountCny = convertToCny(transaction.price * transaction.quantity * mult, transaction.market, exchangeRates);
          if (transaction.market === 'CASH' || transaction.symbol === 'CASH') {
            cashBalanceCny -= amountCny;
          } else {
            const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
            const current = positions[key] || this.createEmptyPosition(transaction);
            
            const nextQuantity = this.cleanQuantity(current.quantity - transaction.quantity);
            const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost - (transaction.price * transaction.quantity * mult);
            
            positions[key] = {
              ...current,
              quantity: nextQuantity,
              remainingCost: nextRemaining,
              averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult)
            };
          }
          if (!transaction.transferGroupId || !completeTransferGroups.has(transaction.transferGroupId)) totalWithdrawCny += amountCny;
          const transferFees = transaction.commission + transaction.tax;
          if (transferFees > 0) {
            totalCommissionCny += convertToCny(transaction.commission, transaction.market, exchangeRates);
            totalTaxCny += convertToCny(transaction.tax, transaction.market, exchangeRates);
            cashBalanceCny -= convertToCny(transferFees, transaction.market, exchangeRates);
          }
          break;
        }

        case 'DIVIDEND': {
          const netDividend = transaction.price * transaction.quantity - transaction.tax;
          const amountCny = convertToCny(netDividend, transaction.market, exchangeRates);
          cashBalanceCny += amountCny;
          
          if (transaction.symbol !== 'CASH') {
            const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
            const current = positions[key] || this.createEmptyPosition(transaction);
            positions[key] = {
              ...current,
              realizedProfit: current.realizedProfit + netDividend
            };
          }
          break;
        }

        case 'TAX': {
          const amountCny = convertToCny(Math.abs(transaction.price * transaction.quantity), transaction.market, exchangeRates);
          cashBalanceCny -= amountCny;
          
          if (transaction.symbol !== 'CASH') {
            const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
            const current = positions[key] || this.createEmptyPosition(transaction);
            positions[key] = {
              ...current,
              realizedProfit: current.realizedProfit - (transaction.price * transaction.quantity)
            };
          }
          break;
        }

        case 'SPLIT': {
          const splitKey = PortfolioSecurityRules.splitEventKey(transaction.market, transaction.symbol, transaction.tradeDate, transaction.price);
          if (appliedSplitEvents.has(splitKey)) {
            break;
          }
          appliedSplitEvents.add(splitKey);

          const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
          const current = positions[key];
          if (current && !this.isAlmostZero(current.quantity)) {
            const nextQuantity = this.cleanQuantity(current.quantity * transaction.price); // 在拆并股中，price 字段存储的是拆股比例
            positions[key] = {
              ...current,
              quantity: nextQuantity,
              averageCost: nextQuantity === 0.0 ? 0.0 : current.remainingCost / (nextQuantity * mult)
            };
          }
          break;
        }

        case 'OTHER': {
          const amountCny = convertToCny(transaction.price * transaction.quantity, transaction.market, exchangeRates);
          cashBalanceCny += amountCny;
          break;
        }

        case 'FX_CONVERSION':
          // 兑换的资金流向通过各自的入金/出金流水体现，此处仅作标示
          break;
      }
    });

    // 计算汇总快照 (Snapshots)
    const quoteMap = new Map<string, QuoteSnapshot>();
    quotes.forEach((q) => {
      quoteMap.set(PortfolioSecurityRules.positionKey(q.symbol, q.market as MarketType), q);
    });

    let holdingsValueCny = 0.0;
    let holdingsCostCny = 0.0;
    let dayProfitCny = 0.0;
    let previousHoldingsValueCny = 0.0;

    Object.values(positions).forEach((position) => {
      const qKey = PortfolioSecurityRules.positionKey(position.symbol, position.market);
      const quote = quoteMap.get(qKey);
      const mult = PortfolioSecurityRules.optionMultiplier(position.assetType, position.symbol);

      const currentPrice = quote?.currentPrice !== null && quote?.currentPrice !== undefined ? quote.currentPrice : position.averageCost;
      const valCny = convertToCny(position.quantity * currentPrice * mult, position.market, exchangeRates);
      holdingsValueCny += valCny;

      holdingsCostCny += convertToCny(position.remainingCost, position.market, exchangeRates);

      if (quote) {
        const curPrice = quote.currentPrice !== null && quote.currentPrice !== undefined ? quote.currentPrice : 0.0;
        const prevClose = quote.previousClose !== null && quote.previousClose !== undefined ? quote.previousClose : curPrice;
        dayProfitCny += convertToCny((curPrice - prevClose) * position.quantity * mult, position.market, exchangeRates);
        previousHoldingsValueCny += convertToCny(prevClose * position.quantity * mult, position.market, exchangeRates);
      } else {
        previousHoldingsValueCny += convertToCny(position.averageCost * position.quantity * mult, position.market, exchangeRates);
      }
    });

    const netInflowCny = totalDepositCny - totalWithdrawCny;
    const totalAssetsCny = holdingsValueCny + cashBalanceCny;
    const previousAssetValueCny = previousHoldingsValueCny + cashBalanceCny;
    const unrealizedProfitCny = holdingsValueCny - holdingsCostCny;

    return {
      positions,
      totalAssetsCny,
      holdingsValueCny,
      cashBalanceCny,
      totalDepositCny,
      totalWithdrawCny,
      netInflowCny,
      unrealizedProfitCny,
      unrealizedProfitPercent: holdingsCostCny === 0.0 ? 0.0 : (unrealizedProfitCny / holdingsCostCny) * 100.0,
      dayProfitCny,
      dayProfitPercent: previousAssetValueCny === 0.0 ? 0.0 : (dayProfitCny / previousAssetValueCny) * 100.0,
      totalCommissionCny,
      totalTaxCny,
      securityTradeCount,
      buyTradeCount,
      sellTradeCount
    };
  }

  private applySecurityTrade(
    transaction: Transaction,
    positions: Record<string, PortfolioPosition>,
    exchangeRates: ExchangeRates
  ): number {
    const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
    const current = positions[key] || this.createEmptyPosition(transaction);
    const mult = PortfolioSecurityRules.optionMultiplier(transaction.assetType, transaction.symbol);

    let cashDelta = 0;
    if (transaction.tradeType === 'BUY') {
      cashDelta = -convertToCny(
        transaction.price * transaction.quantity * mult + transaction.commission + transaction.tax,
        transaction.market,
        exchangeRates
      );
      positions[key] = this.applyBuy(current, transaction);
    } else {
      cashDelta = convertToCny(
        transaction.price * transaction.quantity * mult - transaction.commission - transaction.tax,
        transaction.market,
        exchangeRates
      );
      positions[key] = this.applySell(current, transaction);
    }

    return cashDelta;
  }

  private applyBuy(current: PortfolioPosition, transaction: Transaction): PortfolioPosition {
    const mult = PortfolioSecurityRules.optionMultiplier(transaction.assetType, transaction.symbol);
    
    // 如果之前处于做空（Quantity < 0）状态，先进行平仓回补
    if (current.quantity < 0.0) {
      const coverQuantity = Math.min(-current.quantity, transaction.quantity);
      // 做空平仓盈亏 = (建仓均价 - 买回价格) * 股数 * 乘数
      const coverProfit = (current.averageCost - transaction.price) * coverQuantity * mult;
      const coverFees = transaction.commission + transaction.tax;
      const remainingBuyQty = this.cleanQuantity(transaction.quantity - coverQuantity);

      if (remainingBuyQty > 0.0) {
        return {
          symbol: transaction.symbol,
          name: transaction.name,
          market: transaction.market,
          quantity: remainingBuyQty,
          remainingCost: transaction.price * remainingBuyQty * mult,
          averageCost: transaction.price,
          realizedProfit: current.realizedProfit + coverProfit - coverFees,
          assetType: transaction.assetType as 'STOCK' | 'OPTION',
          underlyingSymbol: transaction.underlyingSymbol
        };
      } else {
        const nextQuantity = this.cleanQuantity(current.quantity + transaction.quantity);
        const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost * (nextQuantity / current.quantity);
        return {
          ...current,
          quantity: nextQuantity,
          remainingCost: nextRemaining,
          averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult),
          realizedProfit: current.realizedProfit + coverProfit - coverFees
        };
      }
    }

    // 做多直接加仓逻辑
    const buyCost = transaction.price * transaction.quantity * mult + transaction.commission + transaction.tax;
    const nextQuantity = this.cleanQuantity(current.quantity + transaction.quantity);
    const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost + buyCost;

    return {
      ...current,
      quantity: nextQuantity,
      remainingCost: nextRemaining,
      averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult)
    };
  }

  private applySell(current: PortfolioPosition, transaction: Transaction): PortfolioPosition {
    const mult = PortfolioSecurityRules.optionMultiplier(transaction.assetType, transaction.symbol);

    // 如果处于做多持仓，进行平仓减仓
    if (current.quantity > 0.0) {
      const closeQuantity = Math.min(current.quantity, transaction.quantity);
      const removedCost = current.averageCost * closeQuantity * mult;
      const closeProceeds = transaction.price * closeQuantity * mult;
      // 已实现盈亏 = 卖出款项 - 被扣减的持仓均价成本 - 交易手续费
      const closeProfit = closeProceeds - removedCost - transaction.commission - transaction.tax;
      const remainingSellQty = this.cleanQuantity(transaction.quantity - closeQuantity);

      if (remainingSellQty > 0.0) {
        // 多头完全平仓后，反向建立空头
        return {
          symbol: transaction.symbol,
          name: transaction.name,
          market: transaction.market,
          quantity: -remainingSellQty,
          remainingCost: -(transaction.price * remainingSellQty * mult),
          averageCost: transaction.price,
          realizedProfit: current.realizedProfit + closeProfit,
          assetType: transaction.assetType as 'STOCK' | 'OPTION',
          underlyingSymbol: transaction.underlyingSymbol
        };
      } else {
        const nextQuantity = this.cleanQuantity(current.quantity - closeQuantity);
        const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost - removedCost;
        return {
          ...current,
          quantity: nextQuantity,
          remainingCost: nextRemaining,
          averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult),
          realizedProfit: current.realizedProfit + closeProfit
        };
      }
    }

    // 做空直接开空仓逻辑
    const nextQuantity = this.cleanQuantity(current.quantity - transaction.quantity);
    const nextRemaining = nextQuantity === 0.0 ? 0.0 : current.remainingCost - (transaction.price * transaction.quantity * mult);
    const openShortFees = transaction.commission + transaction.tax;

    return {
      ...current,
      quantity: nextQuantity,
      remainingCost: nextRemaining,
      averageCost: nextQuantity === 0.0 ? 0.0 : nextRemaining / (nextQuantity * mult),
      realizedProfit: current.realizedProfit - openShortFees
    };
  }

  private applyExpire(transaction: Transaction, positions: Record<string, PortfolioPosition>) {
    const key = PortfolioSecurityRules.positionKey(transaction.symbol, transaction.market);
    const current = positions[key];
    if (!current) return;

    const qtyDelta = transaction.quantity;
    const nextQuantity = this.cleanQuantity(current.quantity > 0.0
      ? Math.max(0.0, current.quantity - qtyDelta)
      : Math.min(0.0, current.quantity + qtyDelta));

    const fraction = current.quantity === 0.0 
      ? 1.0 
      : Math.abs((current.quantity - nextQuantity) / current.quantity);

    const closedCost = current.remainingCost * fraction;
    // 期权归零已实现盈亏即为被清理的持仓账面成本的相反数 (做多亏掉溢价，做空收获溢价)
    const coverProfit = -closedCost;

    positions[key] = {
      ...current,
      quantity: nextQuantity,
      remainingCost: current.remainingCost - closedCost,
      averageCost: nextQuantity === 0.0 ? 0.0 : (current.remainingCost - closedCost) / (nextQuantity * PortfolioSecurityRules.optionMultiplier(transaction.assetType, transaction.symbol)),
      realizedProfit: current.realizedProfit + coverProfit
    };
  }

  private createEmptyPosition(transaction: Transaction): PortfolioPosition {
    return {
      symbol: transaction.symbol,
      name: transaction.name,
      market: transaction.market,
      quantity: 0.0,
      averageCost: 0.0,
      remainingCost: 0.0,
      realizedProfit: 0.0,
      assetType: transaction.assetType as 'STOCK' | 'OPTION',
      underlyingSymbol: transaction.underlyingSymbol
    };
  }

  private isAlmostZero(value: number): boolean {
    return Math.abs(value) < 1e-6;
  }

  private cleanQuantity(qty: number): number {
    const normalized = normalizeQuantity(qty);
    return this.isAlmostZero(normalized) ? 0.0 : normalized;
  }
}
