import {
  emptyExtraction,
  type Extraction,
  type Extractor,
  type RawField,
  type RawLineItem,
} from '../types.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const MONEY = String.raw`(?:[€$£]\s?)?-?\d[\d.,]*[.,]\d{2}(?![\d]|[.,]\d)(?:\s?(?:[€$£]|EUR\b|USD\b|GBP\b))?`;
const MONEY_G = new RegExp(MONEY, 'g');
const QTY = String.raw`\d+(?:[.,]\d+)?`;
const ROW_COLUMNS = new RegExp(`^(.+?)\\s+(${QTY})\\s+(${MONEY})\\s+(${MONEY})$`);
const ROW_QTY_FIRST = new RegExp(`^(${QTY})\\s*[x×]\\s+(.+?)\\s+(${MONEY})\\s+(${MONEY})$`);

const SUBTOTAL_RE =
  /\b(sub-?total|net total|net amount|total excl(?:uding|\.)?(?:\s+(?:tax|vat))?)/i;
const TOTAL_STRONG_RE =
  /\b(total due|amount due|total payable|grand total|balance due|total amount due)/i;
const TOTAL_RE = /\btotal\b/i;
const TAX_RE = /\b(vat|tax|gst|btw|mwst)\b/i;

const CURRENCY_CODES = /\b(EUR|USD|GBP|CHF|PLN|CZK|SEK|NOK|DKK|CAD|AUD|UAH)\b/;
const SYMBOL_CODE: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP' };

interface Line {
  text: string;
  cells: string[];
}

function toLines(text: string): Line[] {
  return text
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((l) => l !== '')
    .map((l) => ({
      text: l,
      cells: l
        .split(/\s{2,}|\t+/)
        .map((c) => c.trim())
        .filter(Boolean),
    }));
}

function stripPercent(s: string): string {
  return s.replace(/\d+(?:[.,]\d+)?\s*%/g, ' ');
}

export function parseMoney(token: string): number | null {
  const m = /^(-?)(\d[\d.,]*)[.,](\d{2})$/.exec(token.replace(/[^\d.,-]/g, ''));
  if (!m) return null;
  return Number(`${m[1]}${(m[2] ?? '').replace(/[.,]/g, '')}.${m[3]}`);
}

function parseQty(token: string): number | null {
  const n = Number(token.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function moneyTokens(s: string): string[] {
  return stripPercent(s).match(MONEY_G) ?? [];
}

function isoDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const monthNo = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

export function findDate(s: string): { iso: string; text: string } | null {
  const candidates: { at: number; text: string; iso: string | null }[] = [];
  const add = (re: RegExp, make: (m: RegExpExecArray) => string | null) => {
    const m = re.exec(s);
    if (m) candidates.push({ at: m.index, text: m[0], iso: make(m) });
  };
  add(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => isoDate(+m[1]!, +m[2]!, +m[3]!));
  add(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/, (m) => isoDate(+m[3]!, +m[2]!, +m[1]!));
  add(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, (m) =>
    +m[1]! > 12 ? isoDate(+m[3]!, +m[2]!, +m[1]!) : isoDate(+m[3]!, +m[1]!, +m[2]!)
  );
  add(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, 'i'), (m) =>
    isoDate(+m[3]!, monthNo(m[2]!), +m[1]!)
  );
  add(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'), (m) =>
    isoDate(+m[3]!, monthNo(m[1]!), +m[2]!)
  );
  const valid = candidates.filter(
    (c): c is { at: number; text: string; iso: string } => c.iso !== null
  );
  valid.sort((a, b) => a.at - b.at);
  const first = valid[0];
  return first ? { iso: first.iso, text: first.text } : null;
}

const INVOICE_DATE_LABEL =
  /^(?:invoice\s+date|date\s+of\s+issue|issue\s+date|issued(?:\s+on)?|date)\b[\s:.-]*/i;
const DUE_DATE_LABEL =
  /^(?:due\s+date|payment\s+due(?:\s+by|\s+date)?|due(?:\s+on|\s+by)?|pay\s+by|payable\s+by|payment\s+date)\b[\s:.-]*/i;
const NUMBER_LABEL =
  /^(?:invoice\s*(?:no\b\.?|number|nr\b\.?|num\b\.?|#)|inv\.?\s*(?:no\b\.?|#)|number)\s*[:#.-]?\s*/i;
const VENDOR_LABEL = /^(?:from|seller|supplier|vendor|issued\s+by|billed\s+from)\b\s*:?\s*/i;
const GENERIC_CELL =
  /^(?:(?:tax\s+)?invoice|rechnung|facture|from|bill(?:ed)?\s+to|page\s+\d+.*)$/i;

function labeled(
  lines: Line[],
  label: RegExp,
  pick: (rest: string) => { value: string; end: number } | null,
  firstCellOnNextLine: boolean
): RawField | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (let c = 0; c < line.cells.length; c++) {
      const cell = line.cells[c]!;
      const m = label.exec(cell);
      if (!m) continue;
      const rest = cell.slice(m[0].length);
      const here = pick(rest);
      if (here) return { value: here.value, source: cell.slice(0, m[0].length + here.end).trim() };
      if (rest.trim() !== '') continue;
      const nextCell = line.cells[c + 1];
      const sibling = nextCell ? pick(nextCell) : null;
      if (sibling) return { value: sibling.value, source: nextCell!.slice(0, sibling.end).trim() };
      const next = lines[i + 1];
      const candidate = next ? (firstCellOnNextLine ? next.cells[0] : next.text) : undefined;
      const below = candidate ? pick(candidate) : null;
      if (below) return { value: below.value, source: candidate!.slice(0, below.end).trim() };
    }
  }
  return null;
}

function pickDate(rest: string) {
  const d = findDate(rest);
  return d ? { value: d.iso, end: rest.indexOf(d.text) + d.text.length } : null;
}

function pickNumber(rest: string) {
  const trimmed = rest.trim();
  const m = /^[A-Za-z0-9][A-Za-z0-9\-/_.]*/.exec(trimmed);
  if (!m) return null;
  const token = m[0].replace(/[.\-/_]+$/, '');
  if (!/\d/.test(token)) return null;
  return { value: token, end: rest.indexOf(token) + token.length };
}

function findVendor(lines: Line[]): RawField | null {
  const usable = (cell: string) =>
    /[A-Za-z]{3}/.test(cell) && !GENERIC_CELL.test(cell) && !findDate(cell);
  for (let i = 0; i < lines.length; i++) {
    for (const cell of lines[i]!.cells) {
      const m = VENDOR_LABEL.exec(cell);
      if (!m) continue;
      const rest = cell.slice(m[0].length).trim();
      if (rest && usable(rest)) return { value: rest, source: cell };
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const next = lines[j]!.cells[0];
        if (next && usable(next)) return { value: next, source: next };
      }
    }
  }
  for (const line of lines.slice(0, 6)) {
    const cell = line.cells.find(usable);
    if (cell) return { value: cell, source: cell };
  }
  return null;
}

function findCurrency(text: string): RawField | null {
  const code = CURRENCY_CODES.exec(text);
  if (code) return { value: code[1], source: code[0] };
  const sym = /[€$£]\s?\d[\d.,]*|\d[\d.,]*\s?[€$£]/.exec(text);
  if (sym) {
    const ch = /[€$£]/.exec(sym[0])![0];
    return { value: SYMBOL_CODE[ch], source: sym[0] };
  }
  return null;
}

function lastAmount(line: Line): number | null {
  const tokens = moneyTokens(line.text);
  const last = tokens[tokens.length - 1];
  return last ? parseMoney(last) : null;
}

export class RulesExtractor implements Extractor {
  readonly name = 'rules';

  async extract(text: string): Promise<Extraction> {
    return extractWithRules(text);
  }
}

export function extractWithRules(text: string): Extraction {
  const lines = toLines(text);
  const out = emptyExtraction();
  const set = (name: keyof Extraction['fields'], f: RawField | null) => {
    if (f) out.fields[name] = f;
  };

  set('vendor', findVendor(lines));
  set('invoiceNumber', labeled(lines, NUMBER_LABEL, pickNumber, true));
  set('invoiceDate', labeled(lines, INVOICE_DATE_LABEL, pickDate, false));
  set('dueDate', labeled(lines, DUE_DATE_LABEL, pickDate, false));
  set('currency', findCurrency(text));

  const items: RawLineItem[] = [];
  const subtotal: Line[] = [];
  const strong: Line[] = [];
  const plainTotal: Line[] = [];
  const tax: Line[] = [];
  for (const line of lines) {
    const flat = stripPercent(line.text);
    const qtyFirst = ROW_QTY_FIRST.exec(flat);
    const columns = qtyFirst ? null : ROW_COLUMNS.exec(flat);
    if (qtyFirst) {
      items.push({
        description: qtyFirst[2]!.trim(),
        quantity: parseQty(qtyFirst[1]!),
        unitPrice: parseMoney(qtyFirst[3]!),
        amount: parseMoney(qtyFirst[4]!),
        source: line.text,
      });
      continue;
    }
    if (columns) {
      items.push({
        description: columns[1]!.trim(),
        quantity: parseQty(columns[2]!),
        unitPrice: parseMoney(columns[3]!),
        amount: parseMoney(columns[4]!),
        source: line.text,
      });
      continue;
    }
    if (moneyTokens(line.text).length === 0) continue;
    if (SUBTOTAL_RE.test(line.text)) subtotal.push(line);
    else if (TOTAL_STRONG_RE.test(line.text)) strong.push(line);
    else if (TOTAL_RE.test(line.text)) plainTotal.push(line);
    else if (TAX_RE.test(line.text)) tax.push(line);
  }
  out.lineItems = items;

  const amountField = (line: Line | undefined): RawField | null =>
    line ? { value: lastAmount(line), source: line.text } : null;
  set('subtotal', amountField(subtotal[0]));
  set('tax', amountField(tax[0]));
  set('total', amountField(strong[strong.length - 1] ?? plainTotal[plainTotal.length - 1]));
  return out;
}
