import {
  FIELD_NAMES,
  type Extraction,
  type FieldName,
  type RawField,
  type RawLineItem,
} from './types.js';

export type Status = 'ok' | 'missing' | 'inconsistent';

export interface FieldResult {
  value: string | number | null;
  status: Status;
  reason?: string;
  source?: string;
}

export interface LineItemResult {
  description: string | number | null;
  quantity: string | number | null;
  unitPrice: string | number | null;
  amount: string | number | null;
  status: Status;
  reason?: string;
  source?: string;
}

export interface Validation {
  valid: boolean;
  fields: Record<FieldName, FieldResult>;
  lineItems: LineItemResult[];
  issues: string[];
}

export class SchemaError extends Error {}

const TOLERANCE = 0.01;
const EPS = 1e-9;
const TEXT_FIELDS: FieldName[] = ['vendor', 'invoiceNumber', 'currency'];
const DATE_FIELDS: FieldName[] = ['invoiceDate', 'dueDate'];
const MONEY_FIELDS: FieldName[] = ['subtotal', 'tax', 'total'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const money = (n: number) => n.toFixed(2);
const differs = (a: number, b: number) => Math.abs(a - b) > TOLERANCE + EPS;

function toField(v: unknown): RawField {
  if (isRecord(v) && 'value' in v) {
    return {
      value: v.value,
      source: typeof v.source === 'string' && v.source.trim() ? v.source : null,
    };
  }
  return { value: v ?? null };
}

// Shape check for anything that claims to be an extraction (model output, client edits).
// It rejects the wrong container types; wrong value types are reported per field by validate().
export function parseExtraction(raw: unknown): Extraction {
  if (!isRecord(raw))
    throw new SchemaError('Expected a JSON object with "fields" and "lineItems".');
  if (!isRecord(raw.fields)) throw new SchemaError('"fields" must be an object.');
  if (raw.lineItems !== undefined && raw.lineItems !== null && !Array.isArray(raw.lineItems)) {
    throw new SchemaError('"lineItems" must be an array.');
  }
  const fields = Object.fromEntries(
    FIELD_NAMES.map((n) => [n, toField(raw.fields && (raw.fields as Record<string, unknown>)[n])])
  ) as Record<FieldName, RawField>;
  const lineItems = ((raw.lineItems as unknown[] | null | undefined) ?? []).map(
    (item, i): RawLineItem => {
      if (!isRecord(item)) throw new SchemaError(`lineItems[${i}] must be an object.`);
      return {
        description: item.description ?? null,
        quantity: item.quantity ?? null,
        unitPrice: item.unitPrice ?? null,
        amount: item.amount ?? null,
        source: typeof item.source === 'string' && item.source.trim() ? item.source : null,
      };
    }
  );
  return { fields, lineItems };
}

function shown(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  return JSON.stringify(v);
}

const isBlank = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function isIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return (
    d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!
  );
}

function checkOwn(name: FieldName, raw: RawField): FieldResult {
  const result: FieldResult = { value: shown(raw.value), status: 'ok' };
  if (raw.source) result.source = raw.source;
  const bad = (reason: string) => {
    result.status = 'inconsistent';
    result.reason = reason;
    return result;
  };
  if (isBlank(raw.value)) {
    result.status = 'missing';
    result.reason = 'Not found in the document.';
    return result;
  }
  const v = raw.value;
  if (TEXT_FIELDS.includes(name)) {
    if (typeof v !== 'string') return bad('Expected text.');
    if (name === 'currency' && !/^[A-Z]{3}$/.test(v))
      return bad('Currency must be a 3-letter ISO code such as EUR or USD.');
  } else if (DATE_FIELDS.includes(name)) {
    if (typeof v !== 'string' || !isIsoDate(v))
      return bad('Not a valid calendar date in YYYY-MM-DD form.');
  } else if (MONEY_FIELDS.includes(name)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return bad('Expected a number.');
  }
  return result;
}

function checkItem(item: RawLineItem): LineItemResult {
  const result: LineItemResult = {
    description: shown(item.description),
    quantity: shown(item.quantity),
    unitPrice: shown(item.unitPrice),
    amount: shown(item.amount),
    status: 'ok',
  };
  if (item.source) result.source = item.source;
  const parts: [string, unknown, 'text' | 'number'][] = [
    ['description', item.description, 'text'],
    ['quantity', item.quantity, 'number'],
    ['unit price', item.unitPrice, 'number'],
    ['amount', item.amount, 'number'],
  ];
  const missing = parts.filter(([, v]) => isBlank(v)).map(([n]) => n);
  if (missing.length) {
    result.status = 'missing';
    result.reason = `Missing ${missing.join(', ')}.`;
    return result;
  }
  const wrong = parts.filter(([, v, kind]) =>
    kind === 'text' ? typeof v !== 'string' : typeof v !== 'number' || !Number.isFinite(v)
  );
  if (wrong.length) {
    result.status = 'inconsistent';
    result.reason = `Wrong type for ${wrong.map(([n]) => n).join(', ')}.`;
    return result;
  }
  const q = item.quantity as number;
  const u = item.unitPrice as number;
  const a = item.amount as number;
  if (q === 0) {
    result.status = 'inconsistent';
    result.reason = 'Quantity is zero.';
  } else if (differs(q * u, a)) {
    result.status = 'inconsistent';
    result.reason = `Quantity x unit price is ${money(q * u)}, but the amount is ${money(a)}.`;
  }
  return result;
}

const num = (r: FieldResult): number | null =>
  r.status === 'ok' && typeof r.value === 'number' ? r.value : null;

export function validate(extraction: Extraction): Validation {
  const fields = Object.fromEntries(
    FIELD_NAMES.map((n) => [n, checkOwn(n, extraction.fields[n])])
  ) as Record<FieldName, FieldResult>;
  const lineItems = extraction.lineItems.map(checkItem);
  const issues: string[] = [];
  const flag = (r: FieldResult, reason: string) => {
    r.status = 'inconsistent';
    r.reason = reason;
  };

  const inv = fields.invoiceDate;
  const due = fields.dueDate;
  if (inv.status === 'ok' && due.status === 'ok' && String(due.value) < String(inv.value)) {
    flag(due, 'The due date is before the invoice date.');
  }

  const amounts = lineItems.map((i) => (typeof i.amount === 'number' ? i.amount : null));
  const subtotal = num(fields.subtotal);
  if (lineItems.length === 0) {
    issues.push('lineItems: no line items found.');
  } else if (subtotal !== null && amounts.every((a): a is number => a !== null)) {
    const sum = amounts.reduce((s, a) => s + a, 0);
    if (differs(sum, subtotal)) {
      flag(
        fields.subtotal,
        `Line items add up to ${money(sum)}, but the subtotal is ${money(subtotal)}.`
      );
    }
  }

  const tax = num(fields.tax);
  const total = num(fields.total);
  if (subtotal !== null && tax !== null && total !== null && differs(subtotal + tax, total)) {
    flag(
      fields.total,
      `Subtotal ${money(subtotal)} + tax ${money(tax)} is ${money(subtotal + tax)}, but the total is ${money(total)}.`
    );
  }

  for (const name of FIELD_NAMES) {
    const f = fields[name];
    if (f.status !== 'ok') issues.push(`${name}: ${f.reason}`);
  }
  lineItems.forEach((item, i) => {
    if (item.status !== 'ok') issues.push(`lineItems[${i + 1}]: ${item.reason}`);
  });
  return { valid: issues.length === 0, fields, lineItems, issues };
}
