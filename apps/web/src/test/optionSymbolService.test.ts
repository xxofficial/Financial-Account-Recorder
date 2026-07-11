import { describe, it, expect } from 'vitest';
import {
  normalizeOptionContract,
  buildOccSymbol,
  parseOccSymbol,
  toPolygonOptionTicker,
  toContractKey,
  parseOptionSymbol,
} from '../services/options/optionSymbolService';

describe('optionSymbolService', () => {
  it('should build correct OCC symbol for AAPL call 200', () => {
    const result = buildOccSymbol({
      underlying: 'AAPL',
      expirationDate: '2026-01-16',
      side: 'call',
      strike: 200,
    });
    expect(result).toBe('AAPL260116C00200000');
  });

  it('should build correct OCC symbol for SPY put 500', () => {
    const result = buildOccSymbol({
      underlying: 'SPY',
      expirationDate: '2026-12-18',
      side: 'put',
      strike: 500,
    });
    expect(result).toBe('SPY261218P00500000');
  });

  it('should normalize option contract with provider symbols', () => {
    const result = normalizeOptionContract({
      underlying: 'AAPL',
      expirationDate: '2026-01-16',
      side: 'call',
      strike: 200,
    });
    expect(result.contractKey).toBe('US:OPTION:AAPL:2026-01-16:C:200');
    expect(result.occSymbol).toBe('AAPL260116C00200000');
    expect(result.providerSymbols.polygon).toBe('O:AAPL260116C00200000');
    expect(result.providerSymbols.massive).toBe('O:AAPL260116C00200000');
    expect(result.underlying).toBe('AAPL');
    expect(result.expirationDate).toBe('2026-01-16');
    expect(result.side).toBe('call');
    expect(result.strike).toBe(200);
  });

  it('should parse OCC symbol correctly', () => {
    const result = parseOccSymbol('AAPL260116C00200000');
    expect(result.underlying).toBe('AAPL');
    expect(result.expirationDate).toBe('2026-01-16');
    expect(result.side).toBe('call');
    expect(result.strike).toBe(200);
    expect(result.contractKey).toBe('US:OPTION:AAPL:2026-01-16:C:200');
  });

  it('should parse OCC symbol with O: prefix', () => {
    const result = parseOccSymbol('O:AAPL260116C00200000');
    expect(result.underlying).toBe('AAPL');
    expect(result.strike).toBe(200);
    expect(result.side).toBe('call');
  });

  it('should convert to polygon option ticker', () => {
    expect(toPolygonOptionTicker('AAPL260116C00200000')).toBe('O:AAPL260116C00200000');
    expect(toPolygonOptionTicker('O:AAPL260116C00200000')).toBe('O:AAPL260116C00200000');
  });

  it('should build contract key', () => {
    expect(
      toContractKey({
        underlying: 'SPY',
        expirationDate: '2026-12-18',
        side: 'P',
        strike: 500,
      })
    ).toBe('US:OPTION:SPY:2026-12-18:P:500');
  });

  it('should parse legacy transaction symbol format', () => {
    const result = parseOptionSymbol('AAPL 260116C200', 'AAPL', '2026-01-16', 'CALL', 200);
    expect(result).not.toBeNull();
    expect(result?.contractKey).toBe('US:OPTION:AAPL:2026-01-16:C:200');
  });

  it('should throw on invalid side', () => {
    expect(() =>
      buildOccSymbol({
        underlying: 'AAPL',
        expirationDate: '2026-01-16',
        side: 'X' as any,
        strike: 200,
      })
    ).toThrow();
  });

  it('should throw on invalid expiration date', () => {
    expect(() =>
      buildOccSymbol({
        underlying: 'AAPL',
        expirationDate: '26-01-16',
        side: 'call',
        strike: 200,
      })
    ).toThrow();
  });
});
