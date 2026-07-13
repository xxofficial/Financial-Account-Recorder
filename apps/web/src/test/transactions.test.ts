import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../db/schema';
import { cashFlow, currencyFor, formatDateTitle, groupTransactionsByDate, LongPressButton, sceneFor } from '../pages/TransactionsPage';

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    ledgerId: 1,
    tradeType: 'BUY',
    platform: 'SCHWAB',
    sourceChannel: null,
    externalReference: null,
    market: 'US',
    symbol: 'AAPL',
    name: 'Apple',
    tradeDate: '2026-07-10',
    tradeTime: '09:30:00',
    price: 10,
    quantity: 2,
    commission: 2,
    tax: 1,
    note: '',
    createdAt: 1,
    updatedAt: 1,
    investorName: null,
    assetType: 'STOCK',
    underlyingSymbol: null,
    expiryDate: null,
    strikePrice: null,
    optionType: null,
    contractKey: null,
    occSymbol: null,
    fxFromCurrency: null,
    fxFromAmount: null,
    fxToCurrency: null,
    fxToAmount: null,
    fxRate: null,
    ...overrides,
  };
}

describe('transactions Android parity helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('enters batch mode on long press without firing navigation click', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(createElement(LongPressButton, { onClick, onLongPress, children: '流水' }));
    const button = screen.getByRole('button', { name: '流水' });
    fireEvent.pointerDown(button, { pointerType: 'touch', button: 0 });
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).toHaveBeenCalledOnce();
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('calculates cash flow with option multiplier and fees', () => {
    expect(cashFlow(transaction({ assetType: 'OPTION', quantity: 2 }))).toBe(-2003);
    expect(cashFlow(transaction({ tradeType: 'SELL', assetType: 'OPTION', quantity: 2 }))).toBe(1997);
    expect(cashFlow(transaction({ tradeType: 'DIVIDEND', price: 50, quantity: 1, tax: 3 }))).toBe(47);
  });

  it('classifies currency and business scenes like Android', () => {
    expect(currencyFor(transaction())).toBe('USD');
    expect(currencyFor(transaction({ market: 'HK' }))).toBe('HKD');
    expect(sceneFor(transaction())).toBe('STOCK_TRADE');
    expect(sceneFor(transaction({ assetType: 'OPTION' }))).toBe('OPTION_TRADE');
    expect(sceneFor(transaction({ tradeType: 'DEPOSIT', symbol: 'CASH' }))).toBe('CASH_IO');
    expect(sceneFor(transaction({ tradeType: 'OTHER', name: 'IPO allocation' }))).toBe('IPO');
  });

  it('groups sections by descending transaction date and formats the title', () => {
    const sections = groupTransactionsByDate([
      transaction({ id: 1, tradeDate: '2026-07-08' }),
      transaction({ id: 2, tradeDate: '2026-07-10' }),
      transaction({ id: 3, tradeDate: '2026-07-10' }),
    ]);
    expect(sections.map(([date, rows]) => [date, rows.length])).toEqual([['2026-07-10', 2], ['2026-07-08', 1]]);
    expect(formatDateTitle('2026-07-10')).toBe('2026年7月10日');
  });
});
