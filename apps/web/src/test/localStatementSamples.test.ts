import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePdfStatementText } from '@recoder/core';

const root = resolve(process.cwd(), '../../samples/Statements');
const files = {
  longbridge: resolve(root, 'longBridge/extracted/statement-monthly-202604-H11275047.txt'),
  hsbc: resolve(root, 'hsbc/extracted_hsbc/2026-1.txt'),
  usmart: resolve(root, 'uSMART/extracted/20260601-10090910-80205330-M21.txt'),
  schwab: resolve(process.cwd(), '../../tmp/pdfs/schwab-202606.txt'),
};
const localDescribe = Object.values(files).every(existsSync) ? describe : describe.skip;

// These supplied, gitignored text extracts are the compatibility corpus for
// first-release PDF parsers. CI skips the suite when no local samples exist.
localDescribe('local first-release statement samples', () => {
  it('parses Longbridge transaction blocks', () => {
    const result = parsePdfStatementText(readFileSync(files.longbridge, 'utf8'));
    expect(result.warnings).toEqual([]);
    expect(result.candidates.length).toBeGreaterThan(5);
    expect(result.candidates.every((candidate) => candidate.platform === 'LONGBRIDGE')).toBe(true);
  });

  it('parses HSBC transaction summaries with stable references', () => {
    const result = parsePdfStatementText(readFileSync(files.hsbc, 'utf8'));
    expect(result.warnings).toEqual([]);
    expect(result.candidates.length).toBeGreaterThan(10);
    expect(result.candidates.every((candidate) => candidate.platform === 'HSBC' && candidate.externalReference.length > 0)).toBe(true);
  });

  it('parses uSMART trade rows and their fee fields', () => {
    const result = parsePdfStatementText(readFileSync(files.usmart, 'utf8'));
    expect(result.warnings).toEqual([]);
    expect(result.candidates.length).toBeGreaterThan(10);
    expect(result.candidates.some((candidate) => candidate.commission > 0 || candidate.tax > 0)).toBe(true);
    expect(result.candidates.every((candidate) => candidate.platform === 'USMART')).toBe(true);
  });

  it('parses the supplied Schwab statement transaction-detail table', () => {
    const result = parsePdfStatementText(readFileSync(files.schwab, 'utf8'));
    expect(result.warnings).toEqual([]);
    expect(result.candidates.length).toBeGreaterThan(2);
    expect(result.candidates.every((candidate) => candidate.platform === 'SCHWAB')).toBe(true);
  });
});
