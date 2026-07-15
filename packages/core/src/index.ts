import type { BackupV5Transaction } from '@recoder/contracts';

export type ImportedBrokerPlatform = 'ZHUORUI' | 'SCHWAB' | 'HSBC' | 'LONGBRIDGE' | 'USMART' | 'UNSPECIFIED';
export type ImportedTradeType =
  | 'BUY' | 'SELL' | 'DEPOSIT' | 'WITHDRAW' | 'TRANSFER_OUT' | 'TRANSFER_IN'
  | 'INTEREST' | 'SPLIT' | 'EXPIRE' | 'DIVIDEND' | 'TAX' | 'FX_CONVERSION' | 'OTHER';
export type ImportedMarket = 'A_SHARE' | 'HK' | 'US';

/**
 * A transport-neutral trade candidate. Native code only brings text/PDFs into
 * the inbox; this shape is deliberately produced by TypeScript so the same
 * parser result is reviewable on Android and on the web.
 */
export interface ParsedTradeCandidate {
  id: string;
  platform: ImportedBrokerPlatform;
  sourceChannel: 'ZHUORUI_EMAIL' | 'SCHWAB_EMAIL' | 'HSBC_EMAIL' | 'PDF_TEXT' | 'CSV_TEXT' | 'SHARED_TEXT';
  externalReference: string;
  tradeType: ImportedTradeType;
  market: ImportedMarket;
  symbol: string;
  name: string;
  currency: 'CNY' | 'HKD' | 'USD' | '';
  tradeDate: string;
  tradeTime: string;
  price: number;
  quantity: number;
  commission: number;
  tax: number;
  rawText: string;
}

export interface BrokerTextParseResult {
  candidates: ParsedTradeCandidate[];
  warnings: string[];
}

const brokerTextNormalize = (text: string) => text
  .replace(/\u00a0/g, ' ')
  .replace(/\u0000/g, ' ')
  .normalize('NFKC')
  .replace(/\r\n?/g, '\n')
  .trim();

const numberFromText = (value: string): number | null => {
  const normalized = value.replace(/[,$]/g, '').replace(/[()]/g, '').trim();
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  return value.includes('(') && value.includes(')') ? -number : number;
};

const referenceNumber = (value: number) => String(value).replace('-', 'NEG').replace('.', '_');

function parseZhuoruiEmail(rawText: string): ParsedTradeCandidate | null {
  const lines = brokerTextNormalize(rawText).split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== '[图片]' && !/^fwd:/i.test(line));
  const joined = lines.join('\n');
  const header = /您(\d+)(美股|港股|A股)账(?:户|戶)于(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})成功(买入|卖出)证券/.exec(joined);
  if (!header) return null;

  const market = header[2] === '美股' ? 'US' : header[2] === '港股' ? 'HK' : 'A_SHARE';
  const tradeType = header[4] === '买入' ? 'BUY' : 'SELL';
  const detailStart = joined.indexOf('累计成交金额');
  if (detailStart < 0) return null;
  const afterAnchor = joined.slice(detailStart + '累计成交金额'.length);
  const footer = ['卓锐证券为', '卓锐证券官网', '风险提示', '*此为系统邮件', '免责声明', '下载卓锐证券']
    .map((anchor) => afterAnchor.indexOf(anchor))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const tokens = afterAnchor.slice(0, footer ?? afterAnchor.length).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length < 7) return null;
  // Mirrors the established Android rule: five trailing tokens follow the
  // security identity, so price/quantity are fifth/fourth from the end.
  const price = numberFromText(tokens[tokens.length - 5]);
  const quantity = numberFromText(tokens[tokens.length - 4]);
  if (price === null || quantity === null) return null;

  const beforePrice = tokens.slice(0, -5);
  let symbol = '';
  let currency: ParsedTradeCandidate['currency'] = '';
  let consumed = 0;
  for (let count = 1; count <= 3; count += 1) {
    const candidateCurrency = beforePrice.slice(-count).join('').toUpperCase();
    if (candidateCurrency === 'USD' || candidateCurrency === 'HKD' || candidateCurrency === 'CNY') {
      symbol = beforePrice[beforePrice.length - count - 1] ?? '';
      currency = candidateCurrency;
      consumed = count + 1;
      break;
    }
  }
  if (!symbol || !currency) return null;
  const name = beforePrice.slice(0, -consumed).join(' ').trim();
  if (!name) return null;
  const compact = symbol.toUpperCase().trim();
  const normalizedSymbol = market === 'US'
    ? (/^[A-Z][A-Z0-9.-]{0,9}$/.test(compact) ? compact : '')
    : market === 'HK'
      ? (() => { const digits = compact.replace(/^HK/, '').replace(/\.HK$/, '').replace(/\D/g, ''); return digits ? `${digits.padStart(4, '0')}.HK` : ''; })()
      : (() => { const digits = compact.replace(/^(SH|SZ)/, '').split('.')[0].replace(/\D/g, ''); return /^\d{6}$/.test(digits) ? digits : ''; })();
  if (!normalizedSymbol) return null;
  const [tradeDate, tradeTime] = header[3].split(' ');
  const externalReference = ['ZR', header[1], `${tradeDate.replace(/-/g, '')}${tradeTime.replace(/:/g, '')}`, tradeType, normalizedSymbol.replace('.', '_'), referenceNumber(quantity), referenceNumber(price)].join('-');
  return {
    id: externalReference,
    platform: 'ZHUORUI',
    sourceChannel: 'ZHUORUI_EMAIL',
    externalReference,
    tradeType,
    market,
    symbol: normalizedSymbol,
    name,
    currency,
    tradeDate,
    tradeTime,
    price,
    quantity,
    commission: 0,
    tax: 0,
    rawText,
  };
}

const isLabel = (line: string, label: string) => line.trim().toLowerCase() === label.toLowerCase() || line.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`);
const valueAfterLabel = (lines: string[], start: number, end: number, label: string) => {
  const index = Array.from({ length: end - start }, (_, offset) => start + offset).find((lineIndex) => isLabel(lines[lineIndex], label));
  if (index === undefined) return null;
  const inline = lines[index].slice(lines[index].indexOf(':') + 1).trim();
  if (inline && lines[index].includes(':')) return inline;
  for (let cursor = index + 1; cursor < end; cursor += 1) {
    const value = lines[cursor].trim();
    if (!value || /^http/i.test(value)) continue;
    if (value.endsWith(':') || /^[A-Za-z][A-Za-z\s./&-]+:\s*/.test(value)) return null;
    return value;
  }
  return null;
};

function parseSchwabEmail(rawText: string): ParsedTradeCandidate[] {
  const normalized = brokerTextNormalize(rawText);
  const lower = normalized.toLowerCase();
  if (!lower.includes('schwab econfirms') || !(lower.includes('trade confirmation') || lower.includes('symbol:') || lower.includes('trade date:'))) return [];
  const lines = normalized.split('\n').map((line) => line.trim());
  const accountEnding = /account ending(?:\s+in)?\s+(\d+)/i.exec(normalized)?.[1] ?? /account\s+ending\s*[:#]?\s*(\d+)/i.exec(normalized)?.[1] ?? 'UNKNOWN';
  const symbolIndices = lines.flatMap((line, index) => isLabel(line, 'Symbol') ? [index] : []);
  return symbolIndices.flatMap((start, index) => {
    const nextSymbol = symbolIndices[index + 1] ?? lines.length;
    const end = Math.min(nextSymbol, ...['For the above:', 'Additional information'].map((marker) => {
      const found = lines.findIndex((line, lineIndex) => lineIndex > start && line.toLowerCase().includes(marker.toLowerCase()));
      return found >= 0 ? found : lines.length;
    }));
    const symbol = valueAfterLabel(lines, start, end, 'Symbol')?.toUpperCase();
    const action = valueAfterLabel(lines, start, end, 'Action')?.toLowerCase();
    const rawDate = valueAfterLabel(lines, start, end, 'Trade Date');
    const name = valueAfterLabel(lines, start, end, 'Security Description')?.replace(/\s+/g, ' ').trim() || symbol;
    if (!symbol || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || !rawDate || !name || (action !== 'purchase' && action !== 'sale')) return [];
    const dateParts = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(rawDate.trim());
    if (!dateParts) return [];
    const year = dateParts[3].length === 2 ? `20${dateParts[3]}` : dateParts[3];
    const tradeDate = `${year}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}`;
    const totalIndex = Array.from({ length: end - start }, (_, offset) => start + offset).find((lineIndex) => isLabel(lines[lineIndex], 'Total Amount'));
    if (totalIndex === undefined) return [];
    const values = lines.slice(totalIndex + 1, end).map((line) => /[-+]?[$]?\(?[0-9][0-9,]*(?:\.[0-9]+)?\)?/.exec(line)?.[0]).filter((value): value is string => Boolean(value)).map(numberFromText).filter((value): value is number => value !== null);
    if (values.length < 4) return [];
    const [quantity, price, principal] = values;
    const tax = Math.max(0, values.slice(3, -1)[0] ?? 0);
    const tradeType = action === 'purchase' ? 'BUY' : 'SELL';
    const externalReference = ['SW', 'EMAIL', accountEnding, tradeDate, action.toUpperCase(), symbol, referenceNumber(quantity), referenceNumber(price), referenceNumber(principal)].join('-');
    return [{
      id: externalReference,
      platform: 'SCHWAB' as const,
      sourceChannel: 'SCHWAB_EMAIL' as const,
      externalReference,
      tradeType,
      market: 'US' as const,
      symbol,
      name,
      currency: 'USD' as const,
      tradeDate,
      tradeTime: '',
      price,
      quantity,
      commission: 0,
      tax,
      rawText: lines.slice(start, end).join('\n'),
    }];
  });
}

/** Parse only deterministic, text-based broker confirmations. No OCR/LLM fallback exists. */
export function parseBrokerText(rawText: string): BrokerTextParseResult {
  const zhuorui = parseZhuoruiEmail(rawText);
  if (zhuorui) return { candidates: resolveImportedTradeTimes([zhuorui]), warnings: [] };
  const schwab = parseSchwabEmail(rawText);
  if (schwab.length) return { candidates: resolveImportedTradeTimes(schwab), warnings: [] };
  return { candidates: [], warnings: ['未识别为卓锐或嘉信的文本成交通知；请确认来源，或改为手动记账。'] };
}

const numberFromStatement = (value: string) => numberFromText(value.replace(/[^\d,().-]/g, ''));
const statementLines = (text: string) => brokerTextNormalize(text)
  .replace(/⾹/g, '香').replace(/⽶/g, '美').replace(/⼊/g, '入')
  .split('\n').map((line) => line.trim()).filter(Boolean);
const compactDate = (date: string) => date.replace(/\D/g, '');
const monthByName: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const parseDdmmyyy = (value: string) => {
  const match = /^(\d{2})([A-Z]{3})(\d{4})$/i.exec(value.trim());
  return match && monthByName[match[2].toUpperCase()] ? `${match[3]}-${monthByName[match[2].toUpperCase()]}-${match[1]}` : null;
};

function statementCandidate(input: Omit<ParsedTradeCandidate, 'id' | 'sourceChannel' | 'externalReference'> & { sourceChannel?: ParsedTradeCandidate['sourceChannel']; ref?: string }): ParsedTradeCandidate {
  const { ref, sourceChannel, ...candidate } = input;
  const externalReference = ref || `${candidate.platform}-${compactDate(candidate.tradeDate)}-${candidate.tradeType}-${candidate.symbol}-${referenceNumber(candidate.quantity)}-${referenceNumber(candidate.price)}`;
  return {
    ...candidate,
    id: externalReference,
    externalReference,
    sourceChannel: sourceChannel ?? 'PDF_TEXT',
  };
}

/**
 * Mirrors Android's ImportTradeTimeResolver. Brokers often export a business
 * date but no intraday time, so use a stable market-local ordering instead of
 * midnight (which Web's US effective-date rule would treat as the prior day).
 */
export function resolveImportedTradeTimes(candidates: ParsedTradeCandidate[]): ParsedTradeCandidate[] {
  const missingTimeIndexes = new Map<string, number>();
  return candidates.map((candidate) => {
    if (candidate.tradeTime.trim()) return candidate;
    const baseMinutes = candidate.market === 'US' ? 21 * 60 + 35 : 9 * 60 + 35;
    const key = [candidate.tradeDate, candidate.market, candidate.symbol.trim().toUpperCase(), candidate.tradeType].join('|');
    const sequence = missingTimeIndexes.get(key) ?? 0;
    missingTimeIndexes.set(key, sequence + 1);
    const minutes = baseMinutes + sequence;
    return {
      ...candidate,
      tradeTime: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
    };
  });
}

/** Same Asia/Shanghai timestamp used by Android ImportTradeTimeResolver. */
export function importedTradeTimestamp(tradeDate: string, tradeTime: string): number | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradeDate);
  const time = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(tradeTime);
  if (!date || !time) return null;
  const value = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1]) - 8, Number(time[2]), Number(time[3] ?? 0));
  return Number.isFinite(value) ? value : null;
}

function parseLongBridgeStatement(rawText: string): ParsedTradeCandidate[] {
  const lines = statementLines(rawText);
  const candidates: ParsedTradeCandidate[] = [];
  let market: ImportedMarket = 'US';
  let currency: ParsedTradeCandidate['currency'] = 'USD';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/香港市场/.test(line)) { market = 'HK'; currency = 'HKD'; continue; }
    if (/美国市场/.test(line)) { market = 'US'; currency = 'USD'; continue; }
    if (!/^OS\d+$/.test(line) || index < 2) continue;
    const tradeDate = lines[index - 2].replace(/\./g, '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) continue;
    const side = lines[index + 1] ?? '';
    if (!/(买入|卖出|买⼊)/.test(side)) continue;
    const nameLine = lines[index + 2] ?? '';
    const quantity = numberFromStatement(lines[index + 3] ?? '');
    const price = numberFromStatement(lines[index + 4] ?? '');
    if (quantity === null || price === null) continue;
    const codeMatch = /^(\d{1,5}|[A-Za-z][A-Za-z0-9.-]{0,9})\s*(.*)$/.exec(nameLine);
    if (!codeMatch) continue;
    const rawSymbol = codeMatch[1];
    const symbol = market === 'HK' ? `${rawSymbol.replace(/\D/g, '').padStart(4, '0')}.HK` : rawSymbol.toUpperCase();
    const time = lines.slice(index + 5, index + 18).map((value) => /(\d{2}:\d{2}:\d{2})\s+(?:HKT|EDT|EST)/.exec(value)?.[1]).filter((value): value is string => Boolean(value)).at(-1) ?? '';
    candidates.push(statementCandidate({
      platform: 'LONGBRIDGE',
      tradeType: /(买入|买⼊)/.test(side) ? 'BUY' : 'SELL',
      market,
      symbol,
      name: codeMatch[2].trim() || symbol,
      currency,
      tradeDate,
      tradeTime: time,
      price,
      quantity: Math.abs(quantity),
      commission: 0,
      tax: 0,
      rawText: lines.slice(Math.max(0, index - 2), index + 18).join('\n'),
      ref: line,
    }));
  }
  return candidates;
}

function parseHsbcStatement(rawText: string): ParsedTradeCandidate[] {
  const lines = statementLines(rawText);
  const candidates: ParsedTradeCandidate[] = [];
  let symbol = '';
  let name = '';
  for (let index = 0; index < lines.length; index += 1) {
    const security = /^(\d{4,5}|[A-Z][A-Z0-9.-]{0,9})\s+(.+?)\s+\(SHS\)/.exec(lines[index]);
    if (security) {
      symbol = security[1];
      name = security[2].replace(/\s+/g, ' ').trim();
      continue;
    }
    const trade = /^(\d{2}[A-Z]{3}\d{4})\s+\d{2}[A-Z]{3}\d{4}\s+(HKD|USD)\s+([\d,.]+)\s+([\d,.-]+)\s+(HKD|USD)\s+([\d,.]+)$/.exec(lines[index]);
    if (!trade || !symbol) continue;
    const tradeDate = parseDdmmyyy(trade[1]);
    const quantity = numberFromStatement(trade[4]);
    const price = numberFromStatement(trade[3]);
    const reference = lines.slice(index + 1, index + 4).map((line) => /Reference:\s*([A-Z0-9]+)/i.exec(line)?.[1]).find(Boolean);
    const isSell = trade[4].includes('-') || reference?.startsWith('SAL');
    if (!tradeDate || quantity === null || price === null) continue;
    const market: ImportedMarket = trade[2] === 'HKD' ? 'HK' : 'US';
    const normalizedSymbol = market === 'HK' ? `${symbol.padStart(4, '0')}.HK` : symbol.toUpperCase();
    candidates.push(statementCandidate({
      platform: 'HSBC',
      tradeType: isSell ? 'SELL' : 'BUY',
      market,
      symbol: normalizedSymbol,
      name: name || normalizedSymbol,
      currency: trade[2] as ParsedTradeCandidate['currency'],
      tradeDate,
      tradeTime: '',
      price: Math.abs(price),
      quantity: Math.abs(quantity),
      commission: 0,
      tax: 0,
      rawText: lines.slice(Math.max(0, index - 2), index + 4).join('\n'),
      ref: reference || undefined,
    }));
  }
  return candidates;
}

function parseUsmartStatement(rawText: string): ParsedTradeCandidate[] {
  const lines = statementLines(rawText);
  const candidates: ParsedTradeCandidate[] = [];
  let pendingSymbol = '';
  const rowRegex = /(美股|港股)\s+(买入|卖出)\s+([\d,]+)\s+(USD|HKD)\s+([\d,.]+)\s+([\d,.]+)\s+(\d{4}-\d{2}-\d{2})\s+否/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const leading = /^([A-Z][A-Z0-9.-]{0,9})\b/.exec(line)?.[1];
    if (leading && !['USD', 'HKD', 'ETF'].includes(leading)) pendingSymbol = leading;
    const match = rowRegex.exec(line);
    if (!match) continue;
    const symbol = leading ?? pendingSymbol;
    const quantity = numberFromStatement(match[3]);
    const price = numberFromStatement(match[5]);
    if (!symbol || quantity === null || price === null) continue;
    const feeBlock = lines.slice(index + 1, index + 12).join(' ');
    const totalFee = numberFromStatement(/交易费[用⽤]合计\s*([\d,.]+)/.exec(feeBlock)?.[1] ?? '') ?? 0;
    const platformFee = numberFromStatement(/平台费\s*([\d,.]+)/.exec(feeBlock)?.[1] ?? '') ?? 0;
    const market: ImportedMarket = match[1] === '港股' ? 'HK' : 'US';
    candidates.push(statementCandidate({
      platform: 'USMART',
      tradeType: match[2] === '买入' ? 'BUY' : 'SELL',
      market,
      symbol: market === 'HK' ? `${symbol.replace(/\D/g, '').padStart(4, '0')}.HK` : symbol,
      name: symbol,
      currency: match[4] as ParsedTradeCandidate['currency'],
      tradeDate: match[7],
      tradeTime: '',
      price: Math.abs(price),
      quantity: Math.abs(quantity),
      commission: platformFee,
      tax: Math.max(0, totalFee - platformFee),
      rawText: lines.slice(Math.max(0, index - 2), index + 12).join('\n'),
      ref: `USMART-${match[7]}-${symbol}-${index}`,
    }));
  }
  return candidates;
}

function parseSchwabStatement(rawText: string): ParsedTradeCandidate[] {
  let carriedDate = '';
  const lines = statementLines(rawText).map((line) => {
    const dated = /^(\d{2}\/\d{2})\s+/.exec(line);
    if (dated) carriedDate = dated[1];
    return !dated && carriedDate && /^(Purchase|Sale)\b/i.test(line) ? `${carriedDate} ${line}` : line;
  });
  const candidates: ParsedTradeCandidate[] = [];
  const year = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\s*-\s*\d{1,2},?\s*(20\d{2})/i.exec(rawText)?.[1] ?? new Date().getFullYear().toString();
  let active = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/Transaction Details/i.test(lines[index])) { active = true; continue; }
    if (active && /Total Transactions|Endnotes|Terms and Conditions/i.test(lines[index])) active = false;
    if (!active) continue;
    const row = /^(\d{1,2}\/\d{1,2})\s+(Purchase|Sale)(?:\s+Reinvested Shares)?\s+([A-Z][A-Z0-9.-]{0,9})\s+(.+?)\s+(\(?-?[\d,.]+\)?)\s+\$?([\d,.]+)(.*)$/i.exec(lines[index]);
    if (!row) continue;
    const dateParts = row[1].split('/');
    const quantity = numberFromStatement(row[5]);
    const price = numberFromStatement(row[6]);
    if (quantity === null || price === null) continue;
    const values = [...row[7].matchAll(/\(?-?\$?[\d,]+(?:\.\d+)?\)?/g)].map((value) => numberFromStatement(value[0])).filter((value): value is number => value !== null);
    const gross = Math.abs(quantity * price);
    const amountIndex = values.findIndex((value) => Math.abs(Math.abs(value) - gross) < 0.02);
    const tax = amountIndex > 0 ? values.slice(0, amountIndex).reduce((sum, value) => sum + Math.abs(value), 0) : 0;
    const tradeDate = `${year}-${dateParts[0].padStart(2, '0')}-${dateParts[1].padStart(2, '0')}`;
    candidates.push(statementCandidate({
      platform: 'SCHWAB',
      tradeType: row[2].toLowerCase() === 'purchase' ? 'BUY' : 'SELL',
      market: 'US',
      symbol: row[3].toUpperCase(),
      name: row[4].trim(),
      currency: 'USD',
      tradeDate,
      tradeTime: '',
      price: Math.abs(price),
      quantity: Math.abs(quantity),
      commission: 0,
      tax,
      rawText: lines[index],
      ref: `SW-${compactDate(tradeDate)}-${row[2].toUpperCase()}-${row[3]}-${index}`,
    }));
  }
  return candidates;
}

const parseCsvRow = (line: string): string[] => {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; } else quoted = !quoted;
    } else if (character === ',' && !quoted) { values.push(value); value = ''; } else value += character;
  }
  values.push(value);
  return values;
};

/** Parses the CSV exported by Schwab's Transactions page. */
export function parseSchwabTransactionsCsv(rawText: string): BrokerTextParseResult {
  const rows = rawText.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()).map(parseCsvRow);
  const header = rows.shift()?.map((value) => value.trim());
  if (!header || !['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount'].every((name) => header.includes(name))) {
    return { candidates: [], warnings: ['未识别为嘉信 Transactions CSV；请从嘉信网页导出含 Date、Action、Symbol、Description 的 CSV。'] };
  }
  const column = (name: string) => header.indexOf(name);
  const candidates: ParsedTradeCandidate[] = [];
  const taxes: Array<{ date: string; symbol: string; amount: number }> = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    const [month, day, year] = (row[column('Date')] ?? '').split('/');
    const tradeDate = month && day && year ? [year.padStart(4, '20'), month.padStart(2, '0'), day.padStart(2, '0')].join('-') : '';
    const action = (row[column('Action')] ?? '').trim();
    const symbol = (row[column('Symbol')] ?? 'CASH').trim().toUpperCase() || 'CASH';
    const name = (row[column('Description')] ?? symbol).trim() || symbol;
    const quantity = numberFromStatement(row[column('Quantity')] ?? '') ?? 1;
    const price = numberFromStatement(row[column('Price')] ?? '');
    const fee = Math.abs(numberFromStatement(row[column('Fees & Comm')] ?? '') ?? 0);
    const amount = numberFromStatement(row[column('Amount')] ?? '');
    if (!tradeDate || !action) { skipped += 1; return; }
    const normalized = action.toUpperCase();
    if (normalized === 'NRA TAX ADJ') {
      const taxAmount = amount === null ? null : Math.abs(amount);
      const dividend = taxAmount === null ? undefined : [...candidates].reverse().find((candidate) =>
        candidate.tradeType === 'DIVIDEND' && candidate.tradeDate === tradeDate && candidate.symbol === symbol);
      if (dividend && taxAmount !== null) dividend.tax += taxAmount;
      else if (taxAmount !== null) taxes.push({ date: tradeDate, symbol, amount: taxAmount });
      return;
    }
    const tradeType: ImportedTradeType | null =
      normalized === 'BUY' || normalized === 'REINVEST SHARES' ? 'BUY'
        : normalized === 'SELL' ? 'SELL'
          : /DIVIDEND/.test(normalized) ? 'DIVIDEND'
            : normalized === 'MARGIN INTEREST' ? 'INTEREST'
              : normalized === 'DEPOSIT' ? 'DEPOSIT'
                : normalized === 'WITHDRAWAL' ? 'WITHDRAW' : null;
    if (!tradeType) { skipped += 1; return; }
    const dividendTaxIndex = tradeType === 'DIVIDEND' ? taxes.findIndex((tax) => tax.date === tradeDate && tax.symbol === symbol) : -1;
    const tax = dividendTaxIndex >= 0 ? taxes.splice(dividendTaxIndex, 1)[0].amount : 0;
    const isSecurity = tradeType === 'BUY' || tradeType === 'SELL';
    const value = isSecurity ? Math.abs(price ?? (amount ?? 0) / (quantity || 1)) : Math.abs(amount ?? 0);
    if (!Number.isFinite(value) || value === 0) { skipped += 1; return; }
    candidates.push(statementCandidate({
      platform: 'SCHWAB', sourceChannel: 'CSV_TEXT', tradeType, market: 'US', symbol, name, currency: 'USD',
      tradeDate, tradeTime: '', price: value, quantity: isSecurity ? Math.abs(quantity) : 1, commission: fee, tax,
      rawText: row.join(','), ref: ['SWCSV', compactDate(tradeDate), normalized.replace(/\s+/g, '_'), symbol, String(index)].join('-'),
    }));
  });
  for (const tax of taxes) candidates.push(statementCandidate({
    platform: 'SCHWAB', sourceChannel: 'CSV_TEXT', tradeType: 'TAX', market: 'US', symbol: tax.symbol, name: tax.symbol + ' 股息税', currency: 'USD',
    tradeDate: tax.date, tradeTime: '', price: tax.amount, quantity: 1, commission: 0, tax: 0, rawText: 'NRA Tax Adj',
    ref: ['SWCSV', compactDate(tax.date), 'TAX', tax.symbol].join('-'),
  }));
  const warnings = skipped ? ['已跳过 ' + skipped + ' 条嘉信 CSV 中暂不影响账本的记录（如 Journal）。'] : [];
  return { candidates: resolveImportedTradeTimes(candidates), warnings };
}

/** Deterministic, text-only first-release statement parsers. */
export function parsePdfStatementText(rawText: string): BrokerTextParseResult {
  const normalized = brokerTextNormalize(rawText);
  // The same broker can alter localized headings between statement layouts.
  // Run the deterministic parsers independently and select the unambiguous
  // non-empty result instead of relying on one brittle brand/header string.
  const candidates = [
    parseLongBridgeStatement(normalized),
    parseHsbcStatement(normalized),
    parseUsmartStatement(normalized),
    parseSchwabStatement(normalized),
  ].sort((left, right) => right.length - left.length)[0] ?? [];
  return candidates.length
    ? { candidates: resolveImportedTradeTimes(candidates), warnings: [] }
    : { candidates: [], warnings: ['未识别为首发支持券商的文本结单，或结单中没有可导入交易。扫描件不受支持。'] };
}

export function createSyncId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `recoder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function canonicalTransactionString(transaction: Record<string, unknown>): string {
  const fields = [
    'platform', 'externalReference', 'tradeType', 'market', 'symbol', 'tradeDate',
    'tradeTime', 'price', 'quantity', 'commission', 'tax', 'assetType', 'contractKey',
    'fxFromCurrency', 'fxFromAmount', 'fxToCurrency', 'fxToAmount', 'fxRate',
  ];
  const base = fields.map((field) => `${field}=${String(transaction[field] ?? '')}`);
  // Keep legacy fingerprints stable while making new paired transfers
  // content-addressable by their linkage metadata.
  if (transaction.transferGroupId || transaction.transferCounterpartyPlatform) {
    base.push(`transferGroupId=${String(transaction.transferGroupId ?? '')}`);
    base.push(`transferCounterpartyPlatform=${String(transaction.transferCounterpartyPlatform ?? '')}`);
  }
  return base.join('|');
}

export async function createTransactionFingerprint(transaction: Record<string, unknown>): Promise<string> {
  const text = canonicalTransactionString(transaction);
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // Kept only for older WebViews lacking Web Crypto. Modern Android/Web always use SHA-256.
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `legacy-fnv-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function sameTransactionContent(
  left: Pick<BackupV5Transaction, 'fingerprint' | 'updatedAt'>,
  right: Pick<BackupV5Transaction, 'fingerprint' | 'updatedAt'>,
): 'same' | 'incoming-newer' | 'local-newer' | 'conflict' {
  if (left.fingerprint === right.fingerprint) return 'same';
  if (left.updatedAt === right.updatedAt) return 'conflict';
  return left.updatedAt < right.updatedAt ? 'incoming-newer' : 'local-newer';
}

export function isExternalReferenceDuplicate(
  transaction: Pick<BackupV5Transaction, 'platform' | 'externalReference'>,
  existing: Iterable<Pick<BackupV5Transaction, 'platform' | 'externalReference'>>,
): boolean {
  if (!transaction.externalReference) return false;
  return Array.from(existing).some((item) =>
    item.platform === transaction.platform && item.externalReference === transaction.externalReference,
  );
}
