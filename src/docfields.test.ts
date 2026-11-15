import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { ExtractionError, LlmExtractor, parseModelJson } from './extract/llm.js';
import { extractWithRules, findDate, parseMoney, RulesExtractor } from './extract/rules.js';
import { pdfToText } from './ingest.js';
import { Pipeline } from './pipeline.js';
import { emptyExtraction, type Extraction, type RawLineItem } from './types.js';
import { parseExtraction, SchemaError, validate } from './validate.js';

const root = join(import.meta.dirname, '..');

const item = (
  description: string,
  quantity: number,
  unitPrice: number,
  amount: number
): RawLineItem => ({
  description,
  quantity,
  unitPrice,
  amount,
});

function build(
  over: Record<string, unknown> = {},
  lineItems: RawLineItem[] = [item('Widget', 2, 10, 20)]
): Extraction {
  const e = emptyExtraction();
  const base: Record<string, unknown> = {
    vendor: 'Fernbrook Supply Ltd',
    invoiceNumber: 'FB-100',
    invoiceDate: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'EUR',
    subtotal: 20,
    tax: 4,
    total: 24,
    ...over,
  };
  for (const [k, value] of Object.entries(base))
    e.fields[k as keyof Extraction['fields']] = { value };
  e.lineItems = lineItems;
  return e;
}

describe('validate', () => {
  it('accepts a consistent invoice', () => {
    const v = validate(build());
    expect(v.valid).toBe(true);
    expect(v.issues).toEqual([]);
    expect(Object.values(v.fields).every((f) => f.status === 'ok')).toBe(true);
  });

  it('marks absent values as missing', () => {
    const v = validate(build({ invoiceNumber: null, vendor: '  ' }));
    expect(v.fields.invoiceNumber.status).toBe('missing');
    expect(v.fields.vendor.status).toBe('missing');
    expect(v.valid).toBe(false);
  });

  it('rejects dates that are not real calendar dates', () => {
    expect(validate(build({ invoiceDate: '2026-02-30' })).fields.invoiceDate.status).toBe(
      'inconsistent'
    );
    expect(validate(build({ invoiceDate: '04.03.2026' })).fields.invoiceDate.status).toBe(
      'inconsistent'
    );
    expect(validate(build({ invoiceDate: '2026-02-28' })).fields.invoiceDate.status).toBe('ok');
  });

  it('rejects a due date before the invoice date', () => {
    const v = validate(build({ dueDate: '2026-02-01' }));
    expect(v.fields.dueDate).toMatchObject({ status: 'inconsistent' });
    expect(v.fields.dueDate.reason).toMatch(/before the invoice date/);
  });

  it('requires a 3-letter uppercase currency code', () => {
    expect(validate(build({ currency: 'euro' })).fields.currency.status).toBe('inconsistent');
    expect(validate(build({ currency: 'USD' })).fields.currency.status).toBe('ok');
  });

  it('rejects money that is not a number', () => {
    const v = validate(build({ tax: '4,00' }));
    expect(v.fields.tax).toMatchObject({ status: 'inconsistent', reason: 'Expected a number.' });
  });

  it('flags a line item whose amount is not quantity x unit price', () => {
    const v = validate(build({}, [item('Widget', 2, 10, 25)]));
    expect(v.lineItems[0]?.status).toBe('inconsistent');
    expect(v.lineItems[0]?.reason).toMatch(/20\.00.*25\.00/);
  });

  it('allows a one-cent rounding difference on a line item but not two', () => {
    expect(
      validate(build({ subtotal: 20.01, total: 24.01 }, [item('Widget', 3, 6.67, 20.01)]))
        .lineItems[0]?.status
    ).toBe('ok');
    expect(validate(build({}, [item('Widget', 2, 10, 20.02)])).lineItems[0]?.status).toBe(
      'inconsistent'
    );
  });

  it('flags line items that do not add up to the subtotal', () => {
    const v = validate(build({ subtotal: 30, total: 34 }));
    expect(v.fields.subtotal.status).toBe('inconsistent');
    expect(v.fields.subtotal.reason).toMatch(/add up to 20\.00.*30\.00/);
    expect(v.fields.total.status).toBe('ok');
  });

  it('flags subtotal + tax that does not equal the total', () => {
    const v = validate(build({ total: 25 }));
    expect(v.fields.total.status).toBe('inconsistent');
    expect(v.fields.total.reason).toMatch(/24\.00.*25\.00/);
  });

  it('reports a missing line item list', () => {
    const v = validate(build({}, []));
    expect(v.valid).toBe(false);
    expect(v.issues).toContain('lineItems: no line items found.');
  });

  it('reports a line item with missing parts', () => {
    const v = validate(
      build({}, [{ description: 'Widget', quantity: null, unitPrice: 10, amount: 20 }])
    );
    expect(v.lineItems[0]).toMatchObject({ status: 'missing', reason: 'Missing quantity.' });
  });

  it('keeps the source snippet on each field', () => {
    const e = build();
    e.fields.vendor.source = 'Fernbrook Supply Ltd';
    expect(validate(e).fields.vendor.source).toBe('Fernbrook Supply Ltd');
  });
});

describe('parseExtraction', () => {
  it('rejects the wrong container shapes', () => {
    expect(() => parseExtraction('nope')).toThrow(SchemaError);
    expect(() => parseExtraction({ fields: [] })).toThrow(SchemaError);
    expect(() => parseExtraction({ fields: {}, lineItems: 'x' })).toThrow(SchemaError);
    expect(() => parseExtraction({ fields: {}, lineItems: [1] })).toThrow(SchemaError);
  });

  it('accepts bare values and {value, source} pairs', () => {
    const e = parseExtraction({
      fields: { vendor: 'A', total: { value: 5, source: 'Total 5.00' } },
    });
    expect(e.fields.vendor.value).toBe('A');
    expect(e.fields.total).toEqual({ value: 5, source: 'Total 5.00' });
    expect(e.fields.tax.value).toBeNull();
  });
});

const LAYOUT_A = `Alderwick Timber Supplies GmbH  INVOICE
Hafenstraße 14
Invoice No:  RE-2026-0412
Invoice date:  04.03.2026
Due date:  03.04.2026
Description  Qty  Unit price  Amount
Oak boards 40 mm, kiln dried (per m3)  2,5  1.180,00 €  2.950,00 €
Delivery to customer site  1  185,00 €  185,00 €
Subtotal  3.135,00 €
VAT 19%  595,65 €
Total due  3.730,65 €`;

const LAYOUT_C = `From
INVOICE
Northquay Cold Storage B.V.
Koopmansweg 31  Invoice no. 2026/117
3011 AB Rotterdam, Netherlands  Date of issue: 2 Mar 2026
Pay by: 1 Apr 2026
12 x Pallet space, chilled 2-6 C, week 9  € 14,80  € 177,60
1 x Temperature log export  € 45,00  € 45,00
Net total  € 222,60
VAT 21%  € 46,75
Total payable (EUR)  € 269,35`;

describe('rules extractor', () => {
  it('reads a table layout with decimal commas', () => {
    const e = extractWithRules(LAYOUT_A);
    expect(e.fields.vendor.value).toBe('Alderwick Timber Supplies GmbH');
    expect(e.fields.invoiceNumber.value).toBe('RE-2026-0412');
    expect(e.fields.invoiceDate.value).toBe('2026-03-04');
    expect(e.fields.dueDate.value).toBe('2026-04-03');
    expect(e.fields.currency.value).toBe('EUR');
    expect([e.fields.subtotal.value, e.fields.tax.value, e.fields.total.value]).toEqual([
      3135, 595.65, 3730.65,
    ]);
    expect(e.lineItems.map((i) => [i.description, i.quantity, i.unitPrice, i.amount])).toEqual([
      ['Oak boards 40 mm, kiln dried (per m3)', 2.5, 1180, 2950],
      ['Delivery to customer site', 1, 185, 185],
    ]);
    expect(validate(e).valid).toBe(true);
  });

  it('reads a quantity-first layout with the vendor under a From label', () => {
    const e = extractWithRules(LAYOUT_C);
    expect(e.fields.vendor.value).toBe('Northquay Cold Storage B.V.');
    expect(e.fields.invoiceNumber.value).toBe('2026/117');
    expect(e.fields.invoiceDate.value).toBe('2026-03-02');
    expect(e.fields.dueDate.value).toBe('2026-04-01');
    expect(e.fields.total.value).toBe(269.35);
    expect(e.lineItems).toHaveLength(2);
    expect(e.lineItems[0]).toMatchObject({ quantity: 12, unitPrice: 14.8, amount: 177.6 });
    expect(validate(e).valid).toBe(true);
  });

  it('reads the label-above-value layout straight from a bundled PDF', async () => {
    const text = await pdfToText(readFileSync(join(root, 'samples', 'marrow-finch-1087.pdf')));
    const e = await new RulesExtractor().extract(text);
    expect(e.fields.invoiceNumber.value).toBe('MF-1087');
    expect(e.fields.invoiceDate.value).toBe('2026-03-11');
    expect(e.fields.dueDate.value).toBe('2026-04-10');
    expect(e.fields.total.value).toBe(5217.65);
  });

  it('returns null, not a guess, when the invoice number is absent', async () => {
    const text = await pdfToText(readFileSync(join(root, 'samples', 'dunmore-ridge-catering.pdf')));
    const v = validate(extractWithRules(text));
    expect(v.fields.invoiceNumber.status).toBe('missing');
    expect(v.valid).toBe(false);
  });

  it('parses money and dates in the formats it claims to support', () => {
    expect(parseMoney('€ 1.234,50')).toBe(1234.5);
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('12')).toBeNull();
    expect(findDate('Due March 4, 2026')?.iso).toBe('2026-03-04');
    expect(findDate('31.02.2026')).toBeNull();
  });
});

function stubFetch(content: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
    })) as unknown as typeof fetch;
}

const llm = (content: string, status = 200) =>
  new LlmExtractor({
    apiKey: 'k',
    model: 'stub-model',
    baseUrl: 'https://llm.invalid/v1',
    fetchImpl: stubFetch(content, status),
  });

const DOC =
  'Fernbrook Supply Ltd\nInvoice No: FB-100\nInvoice date: 2026-03-01\nTotal due 25.00 EUR';

const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    fields: {
      vendor: { value: 'Fernbrook Supply Ltd', source: 'Fernbrook Supply Ltd' },
      invoiceNumber: { value: 'FB-100', source: 'Invoice No: FB-100' },
      invoiceDate: { value: '2026-03-01', source: 'Invoice date: 2026-03-01' },
      dueDate: { value: null, source: null },
      currency: { value: 'EUR', source: 'EUR' },
      subtotal: { value: 20, source: 'made up line that is not in the document' },
      tax: { value: 4, source: null },
      total: { value: 25, source: 'Total due 25.00 EUR' },
      ...over,
    },
    lineItems: [{ description: 'Widget', quantity: 2, unitPrice: 10, amount: 20, source: null }],
  });

describe('llm extractor', () => {
  it('sends an OpenAI-compatible request and parses fenced JSON', async () => {
    let seen:
      | { url: string; body: { model: string; messages: { role: string }[] }; auth: string }
      | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        body: JSON.parse(String(init.body)),
        auth: (init.headers as Record<string, string>).authorization ?? '',
      };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '```json\n' + answer() + '\n```' } }] })
      );
    }) as unknown as typeof fetch;
    const extractor = new LlmExtractor({
      apiKey: 'secret',
      model: 'stub-model',
      baseUrl: 'https://llm.invalid/v1/',
      fetchImpl,
    });
    const e = await extractor.extract(DOC);
    expect(seen?.url).toBe('https://llm.invalid/v1/chat/completions');
    expect(seen?.auth).toBe('Bearer secret');
    expect(seen?.body.model).toBe('stub-model');
    expect(e.fields.vendor.value).toBe('Fernbrook Supply Ltd');
  });

  it('throws a clear error on malformed JSON', async () => {
    await expect(llm('Sure! Here is the invoice: {vendor: Fernbrook').extract(DOC)).rejects.toThrow(
      ExtractionError
    );
    expect(() => parseModelJson('no json at all')).toThrow(/malformed JSON/);
  });

  it('throws on a non-2xx response', async () => {
    await expect(llm('{}', 500).extract(DOC)).rejects.toThrow(/status 500/);
  });

  it('rejects JSON of the wrong shape', async () => {
    await expect(llm('{"vendor": "x"}').extract(DOC)).rejects.toThrow(SchemaError);
  });

  it('flags a response whose totals are inconsistent, whatever the model claimed', async () => {
    const result = await new Pipeline(llm(answer())).run(DOC);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.fields.total.status).toBe('inconsistent');
    expect(result.validation.fields.total.reason).toMatch(/24\.00.*25\.00/);
    expect(result.validation.fields.subtotal.status).toBe('ok');
  });

  it('drops a source snippet that is not in the document', async () => {
    const result = await new Pipeline(llm(answer())).run(DOC);
    expect(result.validation.fields.subtotal.source).toBeUndefined();
    expect(result.validation.fields.invoiceNumber.source).toBe('Invoice No: FB-100');
  });

  it('reports a non-numeric amount from the model as inconsistent', async () => {
    const result = await new Pipeline(
      llm(answer({ tax: { value: 'four euros', source: null } }))
    ).run(DOC);
    expect(result.validation.fields.tax).toMatchObject({
      status: 'inconsistent',
      reason: 'Expected a number.',
    });
  });
});

describe('api', () => {
  async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const app = createApp(new Pipeline(new RulesExtractor()), root);
    const server = app.listen(0);
    try {
      return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.close();
    }
  }

  const post = (base: string, path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('extracts and validates pasted text', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/extract', { text: LAYOUT_A });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        mode: string;
        validation: { valid: boolean; fields: Record<string, { value: unknown }> };
      };
      expect(data.mode).toBe('rules');
      expect(data.validation.valid).toBe(true);
      expect(data.validation.fields.total?.value).toBe(3730.65);
    });
  });

  it('answers 422 with a message for bad input', async () => {
    await withServer(async (base) => {
      const tooShort = await post(base, '/api/extract', { text: 'hi' });
      expect(tooShort.status).toBe(422);
      expect(((await tooShort.json()) as { error: string }).error).toMatch(/characters/);
      const noInput = await post(base, '/api/extract', { nothing: true });
      expect(noInput.status).toBe(422);
    });
  });

  it('rejects an upload that is not a PDF', async () => {
    await withServer(async (base) => {
      const form = new FormData();
      form.append(
        'file',
        new Blob(['just some text, not a pdf'], { type: 'application/pdf' }),
        'x.pdf'
      );
      const res = await fetch(base + '/api/extract', { method: 'POST', body: form });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toMatch(/not a PDF/);
    });
  });

  it('extracts a PDF upload', async () => {
    await withServer(async (base) => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([readFileSync(join(root, 'samples', 'tallow-creek-print-20931.pdf'))]),
        'x.pdf'
      );
      const res = await fetch(base + '/api/extract', { method: 'POST', body: form });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        validation: { valid: boolean; fields: Record<string, { value: unknown }> };
      };
      expect(data.validation.fields.invoiceNumber?.value).toBe('TC-20931');
    });
  });

  it('lists samples and serves their text', async () => {
    await withServer(async (base) => {
      const list = (await (await fetch(base + '/api/samples')).json()) as { id: string }[];
      expect(list).toHaveLength(8);
      const one = (await (await fetch(`${base}/api/samples/${list[0]!.id}`)).json()) as {
        text: string;
      };
      expect(one.text.length).toBeGreaterThan(100);
      expect((await fetch(base + '/api/samples/..%2Fpackage')).status).toBe(404);
    });
  });

  it('re-validates edited fields', async () => {
    await withServer(async (base) => {
      const res = await post(base, '/api/validate', {
        fields: { subtotal: { value: 20 }, tax: { value: 4 }, total: { value: 99 } },
        lineItems: [{ description: 'Widget', quantity: 2, unitPrice: 10, amount: 20 }],
      });
      const v = (await res.json()) as { fields: Record<string, { status: string }> };
      expect(v.fields.total?.status).toBe('inconsistent');
      expect((await post(base, '/api/validate', [1])).status).toBe(422);
    });
  });

  it('reports health and the active mode', async () => {
    await withServer(async (base) => {
      expect(await (await fetch(base + '/api/health')).json()).toEqual({ ok: true, mode: 'rules' });
    });
  });
});
