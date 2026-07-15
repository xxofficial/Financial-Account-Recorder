import { createSyncId } from '@recoder/core';
import { db } from '../../db/localDb';
import type { Transaction } from '../../db/schema';
import type { MarketType, PlatformType } from '../../shared/models';
import { PortfolioCalculator, type ExchangeRates } from '../portfolio/portfolioCalculator';

const UNIT_RATES: ExchangeRates = { usdToCny: 1, hkdToCny: 1 };
const calculator = new PortfolioCalculator();

export interface TransferPairDraft {
  ledgerId: number;
  sourcePlatform: string;
  targetPlatform: string;
  market: MarketType;
  symbol: string;
  name: string;
  tradeDate: string;
  tradeTime: string;
  isSecurity: boolean;
  quantity: number;
  amount?: number;
  assetType?: 'STOCK' | 'OPTION';
  underlyingSymbol?: string | null;
  expiryDate?: string | null;
  strikePrice?: number | null;
  optionType?: 'CALL' | 'PUT' | null;
  commission?: number;
  tax?: number;
  note?: string;
}

export interface TransferPair {
  groupId: string;
  out: Transaction;
  in: Transaction;
}

export class TransferValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferValidationError';
  }
}

const transferType = (transaction: Transaction) => transaction.tradeType === 'TRANSFER_OUT' || transaction.tradeType === 'TRANSFER_IN';
const transferTimestamp = (date: string, time: string) => `${date}T${time}`;

function isBeforeTransfer(transaction: Transaction, draft: TransferPairDraft): boolean {
  return transferTimestamp(transaction.tradeDate, transaction.tradeTime) <= transferTimestamp(draft.tradeDate, draft.tradeTime);
}

function normalizeDraft(draft: TransferPairDraft): TransferPairDraft {
  const sourcePlatform = draft.sourcePlatform.trim();
  const targetPlatform = draft.targetPlatform.trim();
  const symbol = draft.isSecurity ? draft.symbol.trim().toUpperCase() : 'CASH';
  const amount = draft.isSecurity ? undefined : Number(draft.amount);
  const quantity = Number(draft.quantity);
  const commission = Number(draft.commission ?? 0);
  const tax = Number(draft.tax ?? 0);
  if (!sourcePlatform || !targetPlatform || sourcePlatform === targetPlatform) throw new TransferValidationError('来源平台和目标平台必须不同。');
  if (!draft.ledgerId || !Number.isInteger(draft.ledgerId)) throw new TransferValidationError('转仓必须属于有效账本。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.tradeDate) || !/^\d{2}:\d{2}:\d{2}$/.test(draft.tradeTime)) throw new TransferValidationError('转仓日期或时间格式不正确。');
  if (!draft.market || draft.market === 'CASH' && draft.isSecurity) throw new TransferValidationError('证券转仓必须选择证券市场。');
  if (!symbol) throw new TransferValidationError('证券代码不能为空。');
  if (!Number.isFinite(quantity) || quantity <= 0) throw new TransferValidationError(draft.isSecurity ? '转仓数量必须大于零。' : '转仓金额必须大于零。');
  if (!draft.isSecurity && (!Number.isFinite(amount) || amount! <= 0)) throw new TransferValidationError('转仓金额必须大于零。');
  if (![commission, tax].every((value) => Number.isFinite(value) && value >= 0)) throw new TransferValidationError('转仓费用不能为负数。');
  return {
    ...draft,
    sourcePlatform,
    targetPlatform,
    symbol,
    quantity: draft.isSecurity ? quantity : 1,
    amount,
    commission,
    tax,
    assetType: draft.isSecurity ? (draft.assetType ?? 'STOCK') : 'STOCK',
    name: draft.isSecurity ? draft.name.trim() || symbol : '现金',
    note: draft.note?.trim() ?? '',
  };
}

async function ledgerHistory(draft: TransferPairDraft, excludeGroupId?: string): Promise<Transaction[]> {
  const transactions = await db.transactions.where('ledgerId').equals(draft.ledgerId).toArray();
  return transactions.filter((transaction) =>
    transaction.platform === draft.sourcePlatform &&
    isBeforeTransfer(transaction, draft) &&
    (!excludeGroupId || transaction.transferGroupId !== excludeGroupId),
  );
}

function availableSourceValue(draft: TransferPairDraft, history: Transaction[]): { available: number; cost: number } {
  if (draft.isSecurity) {
    const snapshot = calculator.calculate(history, [], UNIT_RATES);
    const position = snapshot.positions[`${draft.market}:${draft.symbol}`];
    return { available: position?.quantity ?? 0, cost: position?.averageCost ?? 0 };
  }
  const snapshot = calculator.calculate(history.filter((transaction) => transaction.market === draft.market), [], UNIT_RATES);
  return { available: snapshot.cashBalanceCny, cost: 0 };
}

function makeTransaction(
  draft: TransferPairDraft,
  groupId: string,
  platform: string,
  counterpartyPlatform: string,
  tradeType: 'TRANSFER_IN' | 'TRANSFER_OUT',
  price: number,
  commission: number,
  createdAt: number,
): Omit<Transaction, 'id'> {
  return {
    syncId: createSyncId(),
    sourceFingerprint: undefined,
    ledgerId: draft.ledgerId,
    tradeType,
    platform,
    sourceChannel: null,
    externalReference: null,
    market: draft.market,
    symbol: draft.isSecurity ? draft.symbol : 'CASH',
    name: draft.name,
    tradeDate: draft.tradeDate,
    tradeTime: draft.tradeTime,
    price,
    quantity: draft.quantity,
    commission: tradeType === 'TRANSFER_OUT' ? commission : 0,
    tax: tradeType === 'TRANSFER_OUT' ? draft.tax ?? 0 : 0,
    note: draft.note ?? '',
    createdAt,
    updatedAt: createdAt,
    investorName: null,
    assetType: draft.assetType ?? 'STOCK',
    underlyingSymbol: draft.underlyingSymbol ?? null,
    expiryDate: draft.expiryDate ?? null,
    strikePrice: draft.strikePrice ?? null,
    optionType: draft.optionType ?? null,
    contractKey: null,
    occSymbol: null,
    fxFromCurrency: null,
    fxFromAmount: null,
    fxToCurrency: null,
    fxToAmount: null,
    fxRate: null,
    transferGroupId: groupId,
    transferCounterpartyPlatform: counterpartyPlatform,
  };
}

async function preparePair(draftInput: TransferPairDraft, excludeGroupId?: string): Promise<{ draft: TransferPairDraft; price: number }> {
  const draft = normalizeDraft(draftInput);
  const history = await ledgerHistory(draft, excludeGroupId);
  const { available, cost } = availableSourceValue(draft, history);
  const required = draft.isSecurity ? draft.quantity : (draft.amount ?? 0) + (draft.commission ?? 0) + (draft.tax ?? 0);
  if (available + 1e-8 < required) {
    throw new TransferValidationError(draft.isSecurity
      ? `来源平台可转持仓不足，当前可转 ${available}，请求 ${draft.quantity}。`
      : `来源平台可用现金不足，当前可用 ${available.toFixed(2)}，请求 ${required.toFixed(2)}。`);
  }
  if (draft.isSecurity && cost <= 0) throw new TransferValidationError('无法确定来源持仓成本，请先检查来源平台的持仓流水。');
  return { draft, price: draft.isSecurity ? cost : draft.amount! };
}

export async function getTransferPairByTransactionId(id: number): Promise<TransferPair | null> {
  const transaction = await db.transactions.get(id);
  if (!transaction?.transferGroupId) return null;
  const pair = await db.transactions.where('ledgerId').equals(transaction.ledgerId).toArray();
  const members = pair.filter((item) => item.transferGroupId === transaction.transferGroupId && transferType(item));
  const out = members.find((item) => item.tradeType === 'TRANSFER_OUT');
  const incoming = members.find((item) => item.tradeType === 'TRANSFER_IN');
  if (!out || !incoming || members.length !== 2) throw new TransferValidationError('转仓配对记录不完整，请先修复或删除孤立流水。');
  return { groupId: transaction.transferGroupId, out, in: incoming };
}

export async function createTransferPair(draftInput: TransferPairDraft): Promise<TransferPair> {
  const { draft, price } = await preparePair(draftInput);
  const groupId = createSyncId();
  const now = Date.now();
  const out = makeTransaction(draft, groupId, draft.sourcePlatform, draft.targetPlatform, 'TRANSFER_OUT', price, draft.commission ?? 0, now);
  const incoming = makeTransaction(draft, groupId, draft.targetPlatform, draft.sourcePlatform, 'TRANSFER_IN', price, 0, now);
  let outId: number | undefined;
  let inId: number | undefined;
  await db.transaction('rw', [db.transactions], async () => {
    outId = await db.transactions.add(out as Transaction);
    inId = await db.transactions.add(incoming as Transaction);
  });
  return { groupId, out: { ...out, id: outId }, in: { ...incoming, id: inId } };
}

export async function updateTransferPair(groupId: string, draftInput: TransferPairDraft): Promise<TransferPair> {
  const existing = await db.transactions.toArray();
  const members = existing.filter((item) => item.transferGroupId === groupId && transferType(item));
  const out = members.find((item) => item.tradeType === 'TRANSFER_OUT');
  const incoming = members.find((item) => item.tradeType === 'TRANSFER_IN');
  if (!out?.id || !incoming?.id || members.length !== 2) throw new TransferValidationError('转仓配对记录不完整，无法编辑。');
  const { draft, price } = await preparePair(draftInput, groupId);
  const now = Date.now();
  const nextOut = makeTransaction(draft, groupId, draft.sourcePlatform, draft.targetPlatform, 'TRANSFER_OUT', price, draft.commission ?? 0, out.createdAt);
  const nextIn = makeTransaction(draft, groupId, draft.targetPlatform, draft.sourcePlatform, 'TRANSFER_IN', price, 0, incoming.createdAt);
  await db.transaction('rw', [db.transactions], async () => {
    await db.transactions.update(out.id!, { ...nextOut, syncId: out.syncId, updatedAt: now });
    await db.transactions.update(incoming.id!, { ...nextIn, syncId: incoming.syncId, updatedAt: now });
  });
  return { groupId, out: { ...nextOut, id: out.id, syncId: out.syncId, updatedAt: now }, in: { ...nextIn, id: incoming.id, syncId: incoming.syncId, updatedAt: now } };
}

export async function deleteTransferPairByTransactionId(id: number): Promise<void> {
  const pair = await getTransferPairByTransactionId(id);
  if (!pair?.out.id || !pair.in.id) throw new TransferValidationError('只有完整的配对转仓才能成对删除。');
  await db.transaction('rw', [db.transactions], async () => {
    await db.transactions.bulkDelete([pair.out.id!, pair.in.id!]);
  });
}

export type TransferPlatform = PlatformType;
