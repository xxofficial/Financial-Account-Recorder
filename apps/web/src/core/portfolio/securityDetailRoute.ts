import type { MarketType } from '../../shared/models';
import { PortfolioSecurityRules } from './portfolioCalculator';

type SecurityDetailTarget = {
  symbol: string;
  market: MarketType;
  assetType?: string | null;
  underlyingSymbol?: string | null;
};

/** Builds one canonical stock-detail route for stock and option positions. */
export function securityDetailPath(target: SecurityDetailTarget): string {
  const symbol = PortfolioSecurityRules.attributionSymbol(
    target.symbol,
    target.assetType,
    target.underlyingSymbol,
  );
  return `/analysis/stock/${encodeURIComponent(symbol)}/${target.market}`;
}

/** A derivative name must never become the title of its underlying's page. */
export function securityDetailName(symbol: string, quoteName?: string | null, stockTransactionName?: string | null): string {
  return quoteName?.trim() || stockTransactionName?.trim() || symbol;
}
