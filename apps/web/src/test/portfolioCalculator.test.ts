import { describe, it, expect } from 'vitest';
import { 
  PortfolioCalculator, 
  PortfolioSecurityRules, 
  ExchangeRates, 
  convertToCny 
} from '../core/portfolio/portfolioCalculator';
import { Transaction, QuoteSnapshot } from '../db/schema';

describe('Portfolio Calculator & Rules', () => {
  const calculator = new PortfolioCalculator();
  const defaultRates: ExchangeRates = {
    usdToCny: 7.20,
    hkdToCny: 0.92,
    updatedAtMillis: Date.now()
  };

  const mockTx = (overrides: Partial<Transaction>): Transaction => {
    return {
      ledgerId: 1,
      tradeType: 'BUY',
      platform: 'LONGBRIDGE',
      sourceChannel: null,
      externalReference: null,
      market: 'US',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      tradeDate: '2026-07-01',
      tradeTime: '10:00:00',
      price: 180.00,
      quantity: 10,
      commission: 1.99,
      tax: 0.50,
      note: '',
      investorName: null,
      assetType: 'STOCK',
      underlyingSymbol: null,
      expiryDate: null,
      strikePrice: null,
      optionType: null,
      fxFromCurrency: null,
      fxFromAmount: null,
      fxToCurrency: null,
      fxToAmount: null,
      fxRate: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides
    };
  };

  describe('PortfolioSecurityRules Tests', () => {
    it('1. should identify option symbols and multipliers', () => {
      expect(PortfolioSecurityRules.isOptionAsset('STOCK', 'AAPL')).toBe(false);
      expect(PortfolioSecurityRules.isOptionAsset('OPTION', 'AAPL 260717C180')).toBe(true);
      expect(PortfolioSecurityRules.isOptionAsset('STOCK', 'AAPL 260717C180')).toBe(true); // symbol format matches
      
      expect(PortfolioSecurityRules.optionMultiplier('STOCK', 'AAPL')).toBe(1.0);
      expect(PortfolioSecurityRules.optionMultiplier('OPTION', 'AAPL 260717C180')).toBe(100.0);
    });

    it('2. should calculate correct attribution keys', () => {
      expect(PortfolioSecurityRules.attributionSymbol('AAPL', 'STOCK', null)).toBe('AAPL');
      expect(PortfolioSecurityRules.attributionSymbol('AAPL 260717C180', 'OPTION', 'AAPL')).toBe('AAPL');
      expect(PortfolioSecurityRules.attributionSymbol('AAPL 260717C180', 'OPTION', null)).toBe('AAPL');
    });

    it('3. should handle US night trading effective date', () => {
      // US market transaction at 05:30:00 (before 06:00) should rollback 1 day
      const date1 = PortfolioSecurityRules.effectiveTradeDate('2026-07-02', '05:30:00', 'US', 'BUY');
      expect(date1).toBe('2026-07-01');

      // US market transaction at 06:30:00 (after 06:00) should stay current day
      const date2 = PortfolioSecurityRules.effectiveTradeDate('2026-07-02', '06:30:00', 'US', 'BUY');
      expect(date2).toBe('2026-07-02');

      // Non-US market transaction at 05:30:00 should stay current day
      const date3 = PortfolioSecurityRules.effectiveTradeDate('2026-07-02', '05:30:00', 'HK', 'BUY');
      expect(date3).toBe('2026-07-02');

      // Split transaction at 05:30:00 should stay current day
      const date4 = PortfolioSecurityRules.effectiveTradeDate('2026-07-02', '05:30:00', 'US', 'SPLIT');
      expect(date4).toBe('2026-07-02');
    });
  });

  describe('Calculator Core Operations', () => {
    it('4. should process stock BUY trade', () => {
      const txs = [mockTx({ price: 100, quantity: 10, commission: 2, tax: 1 })];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos).toBeDefined();
      expect(pos.quantity).toBe(10);
      expect(pos.remainingCost).toBe(1003); // 100 * 10 + 2 + 1
      expect(pos.averageCost).toBe(100.3); // 1003 / 10
      expect(pos.realizedProfit).toBe(0);
    });

    it('5. should process multiple BUY trades', () => {
      const txs = [
        mockTx({ tradeDate: '2026-07-01', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeDate: '2026-07-02', price: 120, quantity: 5, commission: 0, tax: 0, createdAt: 2 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.quantity).toBe(15);
      expect(pos.remainingCost).toBe(1600); // 1000 + 600
      expect(pos.averageCost).toBe(1600 / 15);
    });

    it('6. should process partial SELL trade', () => {
      const txs = [
        mockTx({ tradeType: 'BUY', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeType: 'SELL', price: 120, quantity: 4, commission: 0, tax: 0, createdAt: 2 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.quantity).toBe(6);
      expect(pos.remainingCost).toBe(600); // 1000 - 100 * 4
      expect(pos.averageCost).toBe(100);
      expect(pos.realizedProfit).toBe(80); // (120 - 100) * 4
    });

    it('7. should process complete liquidation (clear position)', () => {
      const txs = [
        mockTx({ tradeType: 'BUY', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeType: 'SELL', price: 120, quantity: 10, commission: 2, tax: 1, createdAt: 2 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.quantity).toBe(0);
      expect(pos.remainingCost).toBe(0);
      expect(pos.averageCost).toBe(0);
      expect(pos.realizedProfit).toBe(197); // 1200 - 1000 - 2 - 1 = 197
    });

    it('8. should support Short Selling build-up', () => {
      const txs = [
        mockTx({ tradeType: 'SELL', price: 150, quantity: 5, commission: 2, tax: 1 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.quantity).toBe(-5);
      expect(pos.remainingCost).toBe(-750); // - (150 * 5)
      expect(pos.averageCost).toBe(150);
      expect(pos.realizedProfit).toBe(-3); // fee paid initially: -3
    });

    it('9. should support Short Selling buyback cover', () => {
      const txs = [
        mockTx({ tradeType: 'SELL', price: 150, quantity: 5, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeType: 'BUY', price: 130, quantity: 5, commission: 2, tax: 1, createdAt: 2 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.quantity).toBe(0);
      expect(pos.realizedProfit).toBe(97); // (150 - 130)*5 - 3 = 97
    });

    it('10. should handle cash DEPOSIT and WITHDRAW', () => {
      const txs = [
        mockTx({ tradeType: 'DEPOSIT', market: 'CASH', symbol: 'CASH', price: 1000, quantity: 1 }),
        mockTx({ tradeType: 'WITHDRAW', market: 'CASH', symbol: 'CASH', price: 200, quantity: 1 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);
      expect(snapshot.cashBalanceCny).toBe(800);
      expect(snapshot.totalDepositCny).toBe(1000);
      expect(snapshot.totalWithdrawCny).toBe(200);
      expect(snapshot.netInflowCny).toBe(800);
    });

    it('11. should handle asset TRANSFER_IN and TRANSFER_OUT', () => {
      const txs = [
        mockTx({ tradeType: 'TRANSFER_IN', market: 'US', symbol: 'AAPL', price: 180, quantity: 10 }),
        mockTx({ tradeType: 'TRANSFER_OUT', market: 'US', symbol: 'AAPL', price: 180, quantity: 2 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.quantity).toBe(8);
      expect(pos.averageCost).toBe(180);
      expect(pos.remainingCost).toBe(180 * 8);
    });

    it('11b. keeps a complete paired transfer out of aggregate inflow while preserving cost', () => {
      const txs = [
        mockTx({ tradeType: 'BUY', platform: 'LONGBRIDGE', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeType: 'TRANSFER_OUT', platform: 'LONGBRIDGE', price: 100, quantity: 4, commission: 2, tax: 0, transferGroupId: 'pair-1', transferCounterpartyPlatform: 'SCHWAB', createdAt: 2 }),
        mockTx({ tradeType: 'TRANSFER_IN', platform: 'SCHWAB', price: 100, quantity: 4, commission: 0, tax: 0, transferGroupId: 'pair-1', transferCounterpartyPlatform: 'LONGBRIDGE', createdAt: 2 }),
      ];
      const aggregate = calculator.calculate(txs, [], defaultRates);
      expect(aggregate.positions['US:AAPL'].quantity).toBe(10);
      expect(aggregate.positions['US:AAPL'].remainingCost).toBe(1000);
      expect(aggregate.netInflowCny).toBe(0);
      expect(aggregate.cashBalanceCny).toBe(-7214.4);
      expect(aggregate.totalCommissionCny).toBe(14.4);

      const source = calculator.calculate(txs.filter((tx) => tx.platform === 'LONGBRIDGE'), [], defaultRates);
      const target = calculator.calculate(txs.filter((tx) => tx.platform === 'SCHWAB'), [], defaultRates);
      expect(source.positions['US:AAPL'].quantity).toBe(6);
      expect(target.positions['US:AAPL'].quantity).toBe(4);
      expect(source.totalWithdrawCny).toBe(2880);
      expect(target.totalDepositCny).toBe(2880);
    });

    it('12. should process interest expenses', () => {
      const txs = [
        mockTx({ tradeType: 'DEPOSIT', market: 'CASH', symbol: 'CASH', price: 1000, quantity: 1, createdAt: 1 }),
        mockTx({ tradeType: 'INTEREST', market: 'CASH', symbol: 'CASH', price: 50, quantity: 1, createdAt: 2 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);
      // cashBalanceCny -= Math.abs(price * quantity)
      expect(snapshot.cashBalanceCny).toBe(950);
    });

    it('13. should process stock dividends and taxes', () => {
      const txs = [
        mockTx({ tradeType: 'BUY', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeType: 'DIVIDEND', price: 2.5, quantity: 10, tax: 5, createdAt: 2 }), // Net dividend = 25 - 5 = 20
        mockTx({ tradeType: 'TAX', price: 3, quantity: 1, createdAt: 3 }) // Separate tax = -3
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.realizedProfit).toBe(17); // 20 (div) - 3 (tax) = 17
      expect(snapshot.cashBalanceCny).toBe(-convertToCny(100 * 10, 'US', defaultRates) + convertToCny(20 - 3, 'US', defaultRates)); // Cash decreases by initial BUY, increases by net dividend and decreases by tax
    });

    it('14. should process stock SPLIT events without changing remaining cost', () => {
      const txs = [
        mockTx({ tradeType: 'BUY', price: 100, quantity: 10, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeType: 'SPLIT', price: 2, quantity: 1, tradeDate: '2026-07-02', createdAt: 2 }) // 1-to-2 split
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      expect(pos.quantity).toBe(20); // 10 * 2
      expect(pos.remainingCost).toBe(1000); // Cost remains same
      expect(pos.averageCost).toBe(50); // Average cost halved
    });

    it('15. should handle OPTION Buy and EXPIRE (long position expires worthless)', () => {
      const txs = [
        mockTx({ 
          tradeType: 'BUY', 
          symbol: 'AAPL 260717C180', 
          assetType: 'OPTION', 
          price: 5.0, 
          quantity: 1, 
          commission: 1.0, 
          tax: 0.0, 
          createdAt: 1 
        }),
        mockTx({ 
          tradeType: 'EXPIRE', 
          symbol: 'AAPL 260717C180', 
          assetType: 'OPTION', 
          price: 0.0, 
          quantity: 1, 
          createdAt: 2 
        })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL 260717C180'];
      expect(pos.quantity).toBe(0);
      expect(pos.remainingCost).toBe(0);
      // Option multiplier is 100. Long premium cost: 5.0 * 1 * 100 + 1 = 501. Expired profit: -501
      expect(pos.realizedProfit).toBe(-501); 
    });

    it('16. should handle OPTION Sell and EXPIRE (short position expires worthless)', () => {
      const txs = [
        mockTx({ 
          tradeType: 'SELL', 
          symbol: 'AAPL 260717C180', 
          assetType: 'OPTION', 
          price: 3.0, 
          quantity: 1, 
          commission: 1.0, 
          tax: 0.0, 
          createdAt: 1 
        }),
        mockTx({ 
          tradeType: 'EXPIRE', 
          symbol: 'AAPL 260717C180', 
          assetType: 'OPTION', 
          price: 0.0, 
          quantity: 1, 
          createdAt: 2 
        })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL 260717C180'];
      expect(pos.quantity).toBe(0);
      expect(pos.remainingCost).toBe(0);
      // Sell premium received: 3.0 * 1 * 100 = 300. Commission paid: 1. Net profit: +299.
      expect(pos.realizedProfit).toBe(299); 
    });

    it('17. should convert values accurately via multiple currency rates', () => {
      const txs = [
        mockTx({ market: 'US', tradeType: 'BUY', price: 100, quantity: 1, commission: 0, tax: 0, symbol: 'AAPL', name: 'AAPL', createdAt: 1 }),
        mockTx({ market: 'HK', tradeType: 'BUY', price: 100, quantity: 1, commission: 0, tax: 0, symbol: '00700', name: 'Tencent', createdAt: 2 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);

      // Usd cost: 100 * 7.20 = 720. Hkd cost: 100 * 0.92 = 92.
      expect(snapshot.holdingsValueCny).toBe(812);
    });

    it('18. should fallback to average cost when no quote is provided', () => {
      const txs = [
        mockTx({ tradeType: 'BUY', price: 120, quantity: 5, commission: 0, tax: 0 })
      ];
      const snapshot = calculator.calculate(txs, [], defaultRates);
      // Holding value falls back to: averageCost (120) * quantity (5) * 1 * 7.20 (usd rate) = 4320
      expect(snapshot.holdingsValueCny).toBe(4320);
    });

    it('19. should apply quote updates to calculate correct day profit and holdings value', () => {
      const txs = [
        mockTx({ tradeType: 'BUY', price: 100, quantity: 10, commission: 0, tax: 0 })
      ];
      const quotes: QuoteSnapshot[] = [{
        id: 'US:AAPL',
        symbol: 'AAPL',
        market: 'US',
        name: 'Apple Inc.',
        assetType: 'STOCK',
        currentPrice: 105,
        previousClose: 102,
        change: 3,
        changePercent: 2.94,
        currency: 'USD',
        provider: 'stock-sdk',
        fetchedAt: Date.now()
      }];

      const snapshot = calculator.calculate(txs, quotes, defaultRates);

      // Holdings value = 105 * 10 * 7.20 = 7560
      expect(snapshot.holdingsValueCny).toBe(7560);
      // Unrealized profit = (105 - 100) * 10 * 7.20 = 360
      expect(snapshot.unrealizedProfitCny).toBe(360);
      // Day profit = (105 - 102) * 10 * 7.20 = 216
      expect(snapshot.dayProfitCny).toBe(216);
    });

    it('20. should sort transactions correctly to maintain historical calculation sequence', () => {
      const txs = [
        // Sell occurs on 07-02, but is recorded earlier in index order
        mockTx({ tradeType: 'SELL', price: 150, quantity: 10, tradeDate: '2026-07-02', tradeTime: '10:00:00', commission: 0, tax: 0, createdAt: 200 }),
        // Buy occurs on 07-01, but is recorded later in index order
        mockTx({ tradeType: 'BUY', price: 100, quantity: 10, tradeDate: '2026-07-01', tradeTime: '10:00:00', commission: 0, tax: 0, createdAt: 100 })
      ];
      
      const snapshot = calculator.calculate(txs, [], defaultRates);

      const pos = snapshot.positions['US:AAPL'];
      // If buy was executed first, remaining quantity is 0 and profit is correct.
      // If sell was executed first, we would have negative position first then buy covers it.
      // Let's verify realized profit: (150 - 100)*10 = 500
      expect(pos.quantity).toBe(0);
      expect(pos.realizedProfit).toBe(500);
    });

    it('21. should expose the net inflow, fees, and trade counts shown on the holdings dashboard', () => {
      const txs = [
        mockTx({ tradeType: 'DEPOSIT', market: 'CASH', symbol: 'CASH', price: 1000, quantity: 1, commission: 0, tax: 0, createdAt: 1 }),
        mockTx({ tradeType: 'WITHDRAW', market: 'CASH', symbol: 'CASH', price: 200, quantity: 1, commission: 0, tax: 0, createdAt: 2 }),
        mockTx({ tradeType: 'BUY', market: 'US', symbol: 'AAPL', price: 100, quantity: 2, commission: 2, tax: 1, createdAt: 3 }),
        mockTx({ tradeType: 'SELL', market: 'US', symbol: 'AAPL', price: 110, quantity: 1, commission: 3, tax: 2, createdAt: 4 }),
      ];

      const snapshot = calculator.calculate(txs, [], defaultRates);

      expect(snapshot.totalDepositCny).toBe(1000);
      expect(snapshot.totalWithdrawCny).toBe(200);
      expect(snapshot.netInflowCny).toBe(800);
      expect(snapshot.totalCommissionCny).toBe(36);
      expect(snapshot.totalTaxCny).toBe(21.6);
      expect(snapshot.securityTradeCount).toBe(2);
      expect(snapshot.buyTradeCount).toBe(1);
      expect(snapshot.sellTradeCount).toBe(1);
    });
  });
});
