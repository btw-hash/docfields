export const FIELD_NAMES = [
  'vendor',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'currency',
  'subtotal',
  'tax',
  'total',
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

export interface RawField {
  value: unknown;
  source?: string | null;
}

export interface RawLineItem {
  description: unknown;
  quantity: unknown;
  unitPrice: unknown;
  amount: unknown;
  source?: string | null;
}

export interface Extraction {
  fields: Record<FieldName, RawField>;
  lineItems: RawLineItem[];
}

export interface Extractor {
  readonly name: string;
  extract(text: string): Promise<Extraction>;
}

export function emptyExtraction(): Extraction {
  const fields = Object.fromEntries(FIELD_NAMES.map((n) => [n, { value: null }])) as Record<
    FieldName,
    RawField
  >;
  return { fields, lineItems: [] };
}
