export type SplitDirection = '拆股' | '并股' | '比例';

export interface SplitDisplay {
  direction: SplitDirection;
  ratio: string;
  label: string;
}

const MAX_DECIMAL_DENOMINATOR = 10_000;
const EPSILON = 1e-10;

function gcd(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left || 1;
}

function decimalFraction(value: number): { numerator: number; denominator: number } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = String(value).toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText ? Number(exponentText) : 0;
  if (!Number.isInteger(exponent)) return null;
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = `${whole}${fraction}`.replace(/^[+-]/, '');
  const rawNumerator = Number(digits);
  const rawDenominator = 10 ** fraction.length;
  if (!Number.isSafeInteger(rawNumerator) || !Number.isSafeInteger(rawDenominator)) return null;
  const exponentMultiplier = 10 ** Math.abs(exponent);
  let numerator = exponent >= 0 ? rawNumerator * exponentMultiplier : rawNumerator;
  let denominator = exponent >= 0 ? rawDenominator : rawDenominator * exponentMultiplier;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator > MAX_DECIMAL_DENOMINATOR) return null;
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { numerator, denominator };
}

function fallbackRatio(value: number): string {
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return value > 1 ? `1:${formatted}` : `${(1 / value).toLocaleString(undefined, { maximumFractionDigits: 6 })}:1`;
}

/** Converts the stored new-shares/old-shares factor into a user-facing direction and ratio. */
export function describeSplitFactor(factor: number): SplitDisplay {
  if (!Number.isFinite(factor) || factor <= 0) {
    return { direction: '比例', ratio: '未知', label: '比例未知' };
  }

  if (Math.abs(factor - 1) < EPSILON) {
    return { direction: '比例', ratio: '1:1', label: '比例 1:1' };
  }

  const fraction = decimalFraction(factor);
  const ratio = fraction ? `${fraction.denominator}:${fraction.numerator}` : fallbackRatio(factor);
  const direction = factor > 1 ? '拆股' : '并股';
  return { direction, ratio, label: `${direction} ${ratio}` };
}
