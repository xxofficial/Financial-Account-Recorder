export type OptionSide = 'call' | 'put';

export type NormalizeOptionInput = {
  underlying: string;
  expirationDate: string; // YYYY-MM-DD
  side: OptionSide | 'CALL' | 'PUT' | 'C' | 'P';
  strike: number;
};

export type NormalizedOptionContract = {
  contractKey: string;
  occSymbol: string;
  providerSymbols: {
    polygon: string;
    massive: string;
    occ: string;
  };
  underlying: string;
  expirationDate: string;
  side: OptionSide;
  strike: number;
};

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function normalizeSide(side: NormalizeOptionInput['side']): OptionSide {
  const upper = String(side).toUpperCase();
  if (upper === 'C' || upper === 'CALL') return 'call';
  if (upper === 'P' || upper === 'PUT') return 'put';
  throw new Error(`Invalid option side: ${side}`);
}

function normalizeUnderlying(underlying: string): string {
  return underlying.trim().toUpperCase();
}

function validateExpirationDate(date: string): string {
  if (!ISO_DATE_REGEX.test(date)) {
    throw new Error(`Invalid expiration date: ${date}, expected YYYY-MM-DD`);
  }
  return date;
}

function padStrike(strike: number): string {
  // OCC strike = strike * 1000, integer, padded to 8 digits
  const scaled = Math.round(strike * 1000);
  if (scaled < 0) throw new Error(`Strike must be non-negative: ${strike}`);
  return scaled.toString().padStart(8, '0');
}

export function buildOccSymbol(input: NormalizeOptionInput): string {
  const underlying = normalizeUnderlying(input.underlying);
  const expirationDate = validateExpirationDate(input.expirationDate);
  const side = normalizeSide(input.side);
  const strike = input.strike;

  const [year, month, day] = expirationDate.split('-');
  const yy = year.slice(2);
  const sideChar = side === 'call' ? 'C' : 'P';
  const strikePadded = padStrike(strike);

  return `${underlying}${yy}${month}${day}${sideChar}${strikePadded}`;
}

export function toContractKey(input: NormalizeOptionInput): string {
  const underlying = normalizeUnderlying(input.underlying);
  const expirationDate = validateExpirationDate(input.expirationDate);
  const side = normalizeSide(input.side);
  const strike = input.strike;
  const sideChar = side === 'call' ? 'C' : 'P';
  return `US:OPTION:${underlying}:${expirationDate}:${sideChar}:${strike}`;
}

export function toPolygonOptionTicker(occSymbol: string): string {
  const normalized = occSymbol.startsWith('O:') ? occSymbol.slice(2) : occSymbol;
  return `O:${normalized}`;
}

export function normalizeOptionContract(input: NormalizeOptionInput): NormalizedOptionContract {
  const underlying = normalizeUnderlying(input.underlying);
  const expirationDate = validateExpirationDate(input.expirationDate);
  const side = normalizeSide(input.side);
  const strike = input.strike;

  const occSymbol = buildOccSymbol({ underlying, expirationDate, side, strike });
  const providerSymbol = toPolygonOptionTicker(occSymbol);
  const contractKey = `US:OPTION:${underlying}:${expirationDate}:${side === 'call' ? 'C' : 'P'}:${strike}`;

  return {
    contractKey,
    occSymbol,
    providerSymbols: {
      polygon: providerSymbol,
      massive: providerSymbol,
      occ: occSymbol,
    },
    underlying,
    expirationDate,
    side,
    strike,
  };
}

export function parseOccSymbol(occSymbol: string): NormalizedOptionContract {
  const normalized = occSymbol.startsWith('O:') ? occSymbol.slice(2) : occSymbol;

  if (normalized.length < 15) {
    throw new Error(`Invalid OCC symbol length: ${occSymbol}`);
  }

  // Extract the side character (C or P) which is the 7th character from the end
  // because strike is always 8 digits padded
  const sideChar = normalized.charAt(normalized.length - 9);
  if (sideChar !== 'C' && sideChar !== 'P') {
    throw new Error(`Invalid OCC side character: ${sideChar} in ${occSymbol}`);
  }

  // Underlying is everything before the 6-digit date
  const dateStart = normalized.length - 15;
  const underlying = normalized.substring(0, dateStart).toUpperCase();
  if (!underlying || !/^[A-Z]+$/.test(underlying)) {
    throw new Error(`Invalid underlying in OCC symbol: ${occSymbol}`);
  }

  const datePart = normalized.substring(dateStart, dateStart + 6);
  const yy = datePart.substring(0, 2);
  const mm = datePart.substring(2, 4);
  const dd = datePart.substring(4, 6);
  const yyyy = `20${yy}`; // OCC uses 2-digit year; assume 21st century for US options
  const expirationDate = `${yyyy}-${mm}-${dd}`;
  if (!ISO_DATE_REGEX.test(expirationDate)) {
    throw new Error(`Invalid expiration date in OCC symbol: ${occSymbol}`);
  }

  const strikePart = normalized.substring(dateStart + 7);
  const strikeScaled = parseInt(strikePart, 10);
  if (Number.isNaN(strikeScaled)) {
    throw new Error(`Invalid strike in OCC symbol: ${occSymbol}`);
  }
  const strike = strikeScaled / 1000;

  const side = sideChar === 'C' ? 'call' : 'put';

  return normalizeOptionContract({
    underlying,
    expirationDate,
    side,
    strike,
  });
}

export function parseOptionSymbol(
  symbol: string,
  underlying?: string,
  expirationDate?: string,
  optionType?: 'CALL' | 'PUT' | 'C' | 'P',
  strikePrice?: number
): NormalizedOptionContract | null {
  // Try OCC format first
  const trimmed = symbol.trim();
  if (/^[A-Z]+\d{6}[CP]\d{8}$/i.test(trimmed)) {
    try {
      return parseOccSymbol(trimmed);
    } catch {
      // fall through to fallback parsing
    }
  }

  // Fallback: parse the current transaction symbol format like "AAPL 260116C200"
  if (underlying && expirationDate && optionType && strikePrice !== undefined && strikePrice !== null) {
    return normalizeOptionContract({
      underlying,
      expirationDate,
      side: optionType,
      strike: strikePrice,
    });
  }

  return null;
}

export function getLatestClosedTradingDate(): string {
  const d = new Date();
  const day = d.getDay();
  if (day === 0) {
    // Sunday -> Friday
    d.setDate(d.getDate() - 2);
  } else if (day === 1) {
    // Monday -> Friday
    d.setDate(d.getDate() - 3);
  } else {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split('T')[0];
}

export function isOptionTransaction(tx: {
  assetType?: string | null;
  market?: string | null;
}): boolean {
  return tx.assetType === 'OPTION' && tx.market === 'US';
}
