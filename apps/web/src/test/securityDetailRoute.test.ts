import { describe, expect, it } from 'vitest';
import { securityDetailName } from '../core/portfolio/securityDetailRoute';

describe('securityDetailName', () => {
  it('uses the transaction name when the quote cache contains only the ticker', () => {
    expect(securityDetailName('NVO', 'NVO', 'NOVO-NORDISK A S FSPONSORED ADR')).toBe('NOVO-NORDISK A S FSPONSORED ADR');
  });

  it('falls back to the ticker only when no meaningful name is available', () => {
    expect(securityDetailName('NVO', 'NVO', 'NVO')).toBe('NVO');
  });
});
