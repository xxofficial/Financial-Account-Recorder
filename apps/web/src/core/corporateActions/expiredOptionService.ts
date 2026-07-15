import type { Transaction } from '../../db/schema';
import { db } from '../../db/localDb';

const EPSILON = 1e-8;

export interface ExpiredOptionCandidate {
  id: string;
  ledgerId: number;
  platform: string;
  market: 'A_SHARE' | 'HK' | 'US';
  symbol: string;
  name: string;
  underlyingSymbol: string | null;
  expiryDate: string;
  strikePrice: number | null;
  optionType: 'CALL' | 'PUT' | null;
  contractKey: string | null;
  occSymbol: string | null;
  netQuantity: number;
  quantity: number;
  externalReference: string;
}

function contractIdentity(transaction: Transaction): string {
  return transaction.contractKey
    || [transaction.market, transaction.symbol, transaction.expiryDate, transaction.optionType, transaction.strikePrice ?? ''].join(':');
}

function candidateReference(ledgerId: number, platform: string, identity: string, expiryDate: string): string {
  return `local-expire:${ledgerId}:${encodeURIComponent(platform)}:${encodeURIComponent(identity)}:${expiryDate}`;
}

function signedQuantity(transaction: Transaction): number {
  if (transaction.tradeType === 'BUY' || transaction.tradeType === 'TRANSFER_IN') return transaction.quantity;
  if (transaction.tradeType === 'SELL' || transaction.tradeType === 'TRANSFER_OUT') return -transaction.quantity;
  if (transaction.tradeType === 'EXPIRE') return transaction.quantity * -1;
  return 0;
}

/**
 * Finds expired option positions without changing the ledger. The scan is
 * intentionally local and deterministic; callers must explicitly confirm the
 * result before creating EXPIRE records because exercise/assignment may still
 * have to be recorded manually.
 */
export function findExpiredOptionCandidates(transactions: Transaction[], asOfDate: string): ExpiredOptionCandidate[] {
  const groups = new Map<string, { quantity: number; latest: Transaction; identity: string }>();
  for (const transaction of transactions) {
    if (transaction.assetType !== 'OPTION' || !transaction.expiryDate || transaction.expiryDate >= asOfDate) continue;
    if (!['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT', 'EXPIRE'].includes(transaction.tradeType)) continue;
    const identity = contractIdentity(transaction);
    const key = [transaction.ledgerId, transaction.platform, identity].join('|');
    const existing = groups.get(key);
    const nextQuantity = (existing?.quantity ?? 0) + signedQuantity(transaction);
    groups.set(key, {
      quantity: Math.abs(nextQuantity) < EPSILON ? 0 : nextQuantity,
      latest: existing && existing.latest.tradeDate > transaction.tradeDate ? existing.latest : transaction,
      identity,
    });
  }

  return [...groups.values()]
    .filter((group) => Math.abs(group.quantity) >= EPSILON)
    .map((group) => {
      const transaction = group.latest;
      const externalReference = candidateReference(transaction.ledgerId, transaction.platform, group.identity, transaction.expiryDate!);
      return {
        id: externalReference,
        ledgerId: transaction.ledgerId,
        platform: transaction.platform,
        market: transaction.market as 'A_SHARE' | 'HK' | 'US',
        symbol: transaction.symbol,
        name: transaction.name || transaction.symbol,
        underlyingSymbol: transaction.underlyingSymbol,
        expiryDate: transaction.expiryDate!,
        strikePrice: transaction.strikePrice,
        optionType: transaction.optionType,
        contractKey: transaction.contractKey ?? null,
        occSymbol: transaction.occSymbol ?? null,
        netQuantity: group.quantity,
        quantity: Math.abs(group.quantity),
        externalReference,
      };
    })
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.symbol.localeCompare(b.symbol) || a.platform.localeCompare(b.platform));
}

/** Writes confirmed candidates atomically and is safe to call repeatedly. */
export async function applyExpiredOptionCandidates(candidates: ExpiredOptionCandidate[]): Promise<number> {
  if (!candidates.length) return 0;
  let created = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const candidate of candidates) {
      const existing = await db.transactions
        .where('[platform+externalReference]')
        .equals([candidate.platform, candidate.externalReference])
        .first();
      if (existing) continue;
      const now = Date.now();
      await db.transactions.add({
        ledgerId: candidate.ledgerId,
        tradeType: 'EXPIRE',
        platform: candidate.platform,
        sourceChannel: 'CORPORATE_ACTION_LOCAL',
        externalReference: candidate.externalReference,
        market: candidate.market,
        symbol: candidate.symbol,
        name: candidate.name,
        tradeDate: candidate.expiryDate,
        tradeTime: '23:59:59',
        price: 0,
        quantity: candidate.quantity,
        commission: 0,
        tax: 0,
        note: `用户确认作废：${candidate.expiryDate} 期权到期；如已行权或被指派，请删除本记录并补录实际结算。`,
        createdAt: now,
        updatedAt: now,
        investorName: null,
        assetType: 'OPTION',
        underlyingSymbol: candidate.underlyingSymbol,
        expiryDate: candidate.expiryDate,
        strikePrice: candidate.strikePrice,
        optionType: candidate.optionType,
        contractKey: candidate.contractKey,
        occSymbol: candidate.occSymbol,
        fxFromCurrency: null,
        fxFromAmount: null,
        fxToCurrency: null,
        fxToAmount: null,
        fxRate: null,
        transferGroupId: null,
        transferCounterpartyPlatform: null,
      });
      created += 1;
    }
  });
  return created;
}
