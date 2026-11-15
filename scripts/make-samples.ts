import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

type Currency = 'EUR' | 'USD';
type MoneyStyle = 'eu-suffix' | 'eu-prefix' | 'us' | 'us-eur';

interface Item {
  description: string;
  quantity: number;
  unitPrice: number;
}

interface Spec {
  file: string;
  layout: 'A' | 'B' | 'C';
  currency: Currency;
  style: MoneyStyle;
  vendor: string;
  vendorLines: string[];
  customer: string;
  customerLines: string[];
  number: string | null;
  date: string;
  due: string;
  dateStyle: 'dotted' | 'iso' | 'long' | 'short';
  taxLabel: string;
  taxRate: number;
  items: Item[];
  hiddenItem?: Item;
  footer: string;
}

const specs: Spec[] = [
  {
    file: 'alderwick-timber-0412.pdf',
    layout: 'A',
    currency: 'EUR',
    style: 'eu-suffix',
    vendor: 'Alderwick Timber Supplies GmbH',
    vendorLines: ['Hafenstraße 14', '20457 Hamburg, Germany', 'VAT ID DE 318 204 667'],
    customer: 'Lindqvist Boatworks',
    customerLines: ['Kajen 7', '25761 Büsum'],
    number: 'RE-2026-0412',
    date: '2026-03-04',
    due: '2026-04-03',
    dateStyle: 'dotted',
    taxLabel: 'VAT 19%',
    taxRate: 0.19,
    items: [
      { description: 'Oak boards 40 mm, kiln dried (per m3)', quantity: 2.5, unitPrice: 1180 },
      { description: 'Larch cladding 21 x 146 mm (per m2)', quantity: 64, unitPrice: 38.5 },
      { description: 'Delivery to customer site', quantity: 1, unitPrice: 185 },
    ],
    footer: 'Payment within 30 days of the invoice date. Please quote the invoice number.',
  },
  {
    file: 'marrow-finch-1087.pdf',
    layout: 'B',
    currency: 'USD',
    style: 'us',
    vendor: 'Marrow & Finch Studio LLC',
    vendorLines: ['2210 NE Alder Street', 'Portland, OR 97232'],
    customer: 'Copperline Coffee Roasters',
    customerLines: ['418 Dock Road', 'Astoria, OR 97103'],
    number: 'MF-1087',
    date: '2026-03-11',
    due: '2026-04-10',
    dateStyle: 'long',
    taxLabel: 'Sales tax (8.25%)',
    taxRate: 0.0825,
    items: [
      { description: 'Discovery workshop (hours)', quantity: 6, unitPrice: 145 },
      { description: 'Logo and wordmark design', quantity: 1, unitPrice: 2400 },
      { description: 'Packaging dielines (per sheet)', quantity: 5, unitPrice: 310 },
    ],
    footer: 'Marrow & Finch Studio LLC, 2210 NE Alder Street, Portland, OR 97232',
  },
  {
    file: 'northquay-cold-storage-117.pdf',
    layout: 'C',
    currency: 'EUR',
    style: 'eu-prefix',
    vendor: 'Northquay Cold Storage B.V.',
    vendorLines: ['Koopmansweg 31', '3011 AB Rotterdam, Netherlands'],
    customer: 'Van der Meer Fresh Foods',
    customerLines: ['Industrieweg 9', '2801 KD Gouda'],
    number: '2026/117',
    date: '2026-03-02',
    due: '2026-04-01',
    dateStyle: 'short',
    taxLabel: 'VAT 21%',
    taxRate: 0.21,
    items: [
      { description: 'Pallet space, chilled 2-6 C, week 9', quantity: 12, unitPrice: 14.8 },
      { description: 'Goods in, per pallet', quantity: 12, unitPrice: 6.25 },
      { description: 'Pick and pack, per order line', quantity: 38, unitPrice: 1.9 },
      { description: 'Temperature log export', quantity: 1, unitPrice: 45 },
    ],
    footer: 'Reference 2026/117. Transfers to Rotterdam Zeehaven Bank.',
  },
  {
    file: 'tallow-creek-print-20931.pdf',
    layout: 'A',
    currency: 'USD',
    style: 'us',
    vendor: 'Tallow Creek Print Works',
    vendorLines: ['9 Mill Race Lane', 'Burlington, VT 05401', 'Tax ID 84-1739026'],
    customer: 'Green Mountain Cider Co.',
    customerLines: ['1180 Orchard Hill Road', 'Shelburne, VT 05482'],
    number: 'TC-20931',
    date: '2026-03-18',
    due: '2026-04-17',
    dateStyle: 'iso',
    taxLabel: 'Sales tax 6%',
    taxRate: 0.06,
    items: [
      {
        description: 'Bottle labels, 90 x 120 mm, matte (box of 500)',
        quantity: 8,
        unitPrice: 74.5,
      },
      { description: 'Countertop display cards', quantity: 150, unitPrice: 1.85 },
      { description: 'Die cutting setup', quantity: 1, unitPrice: 120 },
    ],
    footer: 'Terms: net 30. Late balances accrue 1.5% per month.',
  },
  {
    file: 'piperfield-analytics-0079.pdf',
    layout: 'B',
    currency: 'EUR',
    style: 'us-eur',
    vendor: 'Piperfield Analytics Ltd',
    vendorLines: ['Unit 4, Canal Wharf', 'Dublin 8, Ireland'],
    customer: 'Saltmarsh Retail Group',
    customerLines: ['Harbour House', 'Cork T12 X4D2'],
    number: 'PA-0079',
    date: '2026-03-18',
    due: '2026-04-17',
    dateStyle: 'short',
    taxLabel: 'VAT (23%)',
    taxRate: 0.23,
    items: [
      { description: 'Data pipeline audit (days)', quantity: 4, unitPrice: 950 },
      { description: 'Dashboard build, sales and stock', quantity: 1, unitPrice: 3200 },
      { description: 'Analyst training session (hours)', quantity: 3, unitPrice: 160 },
    ],
    footer: 'Piperfield Analytics Ltd, Unit 4, Canal Wharf, Dublin 8',
  },
  {
    file: 'quillon-bay-marine-3318.pdf',
    layout: 'C',
    currency: 'USD',
    style: 'us',
    vendor: 'Quillon Bay Marine Services',
    vendorLines: ['77 Pier Street', 'Annapolis, MD 21401'],
    customer: 'Sable Point Charters',
    customerLines: ['Slip 22, Harbor Cove Marina', 'Kent Island, MD 21666'],
    number: 'QB-3318',
    date: '2026-03-09',
    due: '2026-03-23',
    dateStyle: 'short',
    taxLabel: 'Sales tax 6%',
    taxRate: 0.06,
    items: [
      { description: 'Hull inspection, in water', quantity: 3, unitPrice: 185 },
      { description: 'Zinc anode replacement', quantity: 8, unitPrice: 42.75 },
      { description: 'Bilge pump service', quantity: 2, unitPrice: 96 },
    ],
    footer: 'Reference QB-3318. Payment by check or ACH.',
  },
  {
    file: 'hartsmere-bueromoebel-0233.pdf',
    layout: 'A',
    currency: 'EUR',
    style: 'eu-suffix',
    vendor: 'Hartsmere Büromöbel GmbH',
    vendorLines: ['Gutenbergring 52', '22848 Norderstedt, Germany', 'VAT ID DE 244 981 530'],
    customer: 'Brandt & Voss Steuerberater',
    customerLines: ['Marktplatz 3', '24103 Kiel'],
    number: 'HB-2026-0233',
    date: '2026-03-12',
    due: '2026-04-11',
    dateStyle: 'dotted',
    taxLabel: 'VAT 19%',
    taxRate: 0.19,
    items: [
      { description: 'Height-adjustable desk 160 x 80 cm', quantity: 6, unitPrice: 489 },
      { description: 'Task chair, mesh back', quantity: 6, unitPrice: 265.9 },
    ],
    hiddenItem: { description: 'Cable tray, under-desk', quantity: 6, unitPrice: 34.5 },
    footer: 'Payment within 30 days of the invoice date. Please quote the invoice number.',
  },
  {
    file: 'dunmore-ridge-catering.pdf',
    layout: 'B',
    currency: 'USD',
    style: 'us',
    vendor: 'Dunmore Ridge Catering Co.',
    vendorLines: ['340 Ferry Street', 'Newark, NJ 07105'],
    customer: 'Okafor & Lind Architects',
    customerLines: ['55 Halsey Street, Floor 3', 'Newark, NJ 07102'],
    number: null,
    date: '2026-03-20',
    due: '2026-04-19',
    dateStyle: 'long',
    taxLabel: 'Sales tax (6.625%)',
    taxRate: 0.06625,
    items: [
      { description: 'Working lunch, per head', quantity: 24, unitPrice: 18.5 },
      { description: 'Coffee and pastry service', quantity: 2, unitPrice: 135 },
      { description: 'Delivery and setup', quantity: 1, unitPrice: 60 },
    ],
    footer: 'Dunmore Ridge Catering Co., 340 Ferry Street, Newark, NJ 07105',
  },
];

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function group(n: number, thousands: string, decimal: string): string {
  const [whole = '', frac = ''] = Math.abs(n).toFixed(2).split('.');
  return (n < 0 ? '-' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands) + decimal + frac;
}

function money(n: number, style: MoneyStyle): string {
  switch (style) {
    case 'eu-suffix':
      return `${group(n, '.', ',')} €`;
    case 'eu-prefix':
      return `€ ${group(n, '.', ',')}`;
    case 'us':
      return `$${group(n, ',', '.')}`;
    case 'us-eur':
      return `€${group(n, ',', '.')}`;
  }
}

function qty(n: number, style: MoneyStyle): string {
  const s = String(n);
  return style.startsWith('eu') ? s.replace('.', ',') : s;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function dateText(iso: string, style: Spec['dateStyle']): string {
  const [y = '', m = '', d = ''] = iso.split('-');
  const month = MONTHS[Number(m) - 1] ?? '';
  switch (style) {
    case 'dotted':
      return `${d}.${m}.${y}`;
    case 'iso':
      return iso;
    case 'long':
      return `${month} ${Number(d)}, ${y}`;
    case 'short':
      return `${Number(d)} ${month.slice(0, 3)} ${y}`;
  }
}

function totals(spec: Spec) {
  const printed = spec.items.map((i) => ({ ...i, amount: r2(i.quantity * i.unitPrice) }));
  const all = spec.hiddenItem
    ? [
        ...printed,
        { ...spec.hiddenItem, amount: r2(spec.hiddenItem.quantity * spec.hiddenItem.unitPrice) },
      ]
    : printed;
  const subtotal = r2(all.reduce((s, i) => s + i.amount, 0));
  const tax = r2(subtotal * spec.taxRate);
  return { printed, subtotal, tax, total: r2(subtotal + tax) };
}

type Doc = InstanceType<typeof PDFDocument>;

function put(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  opts: {
    size?: number;
    bold?: boolean;
    color?: string;
    width?: number;
    align?: 'left' | 'right';
  } = {}
) {
  doc
    .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(opts.size ?? 10)
    .fillColor(opts.color ?? '#111111')
    .text(text, x, y, { width: opts.width ?? 400, align: opts.align ?? 'left', lineBreak: false });
}

function rule(doc: Doc, y: number, x1 = 50, x2 = 545, color = '#999999') {
  doc.strokeColor(color).lineWidth(0.6).moveTo(x1, y).lineTo(x2, y).stroke();
}

function layoutA(doc: Doc, s: Spec) {
  const t = totals(s);
  put(doc, s.vendor, 50, 50, { size: 17, bold: true });
  s.vendorLines.forEach((l, i) => put(doc, l, 50, 74 + i * 12, { size: 9, color: '#555555' }));
  put(doc, 'INVOICE', 350, 48, { size: 22, bold: true, width: 195, align: 'right' });
  let my = 112;
  if (s.number) {
    put(doc, 'Invoice No:', 350, my, { size: 10 });
    put(doc, s.number, 430, my, { size: 10, bold: true });
    my += 14;
  }
  put(doc, 'Invoice date:', 350, my, { size: 10 });
  put(doc, dateText(s.date, s.dateStyle), 430, my, { size: 10 });
  put(doc, 'Due date:', 350, my + 14, { size: 10 });
  put(doc, dateText(s.due, s.dateStyle), 430, my + 14, { size: 10 });

  put(doc, 'Bill to', 50, 150, { size: 9, bold: true, color: '#555555' });
  put(doc, s.customer, 50, 164, { size: 10, bold: true });
  s.customerLines.forEach((l, i) => put(doc, l, 50, 178 + i * 12, { size: 10 }));

  doc.rect(50, 226, 495, 20).fill('#e8e8e8');
  put(doc, 'Description', 56, 232, { size: 9, bold: true });
  put(doc, 'Qty', 290, 232, { size: 9, bold: true, width: 50, align: 'right' });
  put(doc, 'Unit price', 350, 232, { size: 9, bold: true, width: 90, align: 'right' });
  put(doc, 'Amount', 450, 232, { size: 9, bold: true, width: 90, align: 'right' });
  let y = 256;
  for (const i of t.printed) {
    put(doc, i.description, 56, y, { size: 10, width: 230 });
    put(doc, qty(i.quantity, s.style), 290, y, { width: 50, align: 'right' });
    put(doc, money(i.unitPrice, s.style), 350, y, { width: 90, align: 'right' });
    put(doc, money(i.amount, s.style), 450, y, { width: 90, align: 'right' });
    y += 20;
  }
  rule(doc, y + 2);
  y += 12;
  put(doc, 'Subtotal', 350, y, { width: 90 });
  put(doc, money(t.subtotal, s.style), 450, y, { width: 90, align: 'right' });
  put(doc, s.taxLabel, 350, y + 16, { width: 90 });
  put(doc, money(t.tax, s.style), 450, y + 16, { width: 90, align: 'right' });
  rule(doc, y + 34, 350, 545, '#333333');
  put(doc, 'Total due', 350, y + 42, { size: 11, bold: true, width: 90 });
  put(doc, money(t.total, s.style), 450, y + 42, {
    size: 11,
    bold: true,
    width: 90,
    align: 'right',
  });
  put(doc, s.footer, 50, 760, { size: 8.5, color: '#555555', width: 495 });
}

function layoutB(doc: Doc, s: Spec) {
  const t = totals(s);
  put(doc, s.vendor, 50, 50, { size: 24, bold: true, width: 495 });
  put(doc, 'Invoice', 50, 84, { size: 12, color: '#666666' });
  let y = 124;
  const block = (label: string, value: string) => {
    put(doc, label, 50, y, { size: 8, color: '#777777' });
    put(doc, value, 50, y + 12, { size: 11, bold: true });
    y += 40;
  };
  if (s.number) block('INVOICE NUMBER', s.number);
  block('ISSUED', dateText(s.date, s.dateStyle));
  block('DUE', dateText(s.due, s.dateStyle));

  put(doc, 'BILLED TO', 320, 124, { size: 8, color: '#777777' });
  put(doc, s.customer, 320, 136, { size: 11, bold: true });
  s.customerLines.forEach((l, i) => put(doc, l, 320, 152 + i * 13, { size: 10 }));

  rule(doc, 276, 50, 545, '#333333');
  put(doc, 'ITEM', 50, 284, { size: 8, color: '#777777' });
  put(doc, 'QTY', 300, 284, { size: 8, color: '#777777', width: 40, align: 'right' });
  put(doc, 'PRICE', 350, 284, { size: 8, color: '#777777', width: 90, align: 'right' });
  put(doc, 'TOTAL', 450, 284, { size: 8, color: '#777777', width: 95, align: 'right' });
  rule(doc, 298);
  let ry = 308;
  for (const i of t.printed) {
    put(doc, i.description, 50, ry, { size: 10.5, width: 245 });
    put(doc, qty(i.quantity, s.style), 300, ry, { size: 10.5, width: 40, align: 'right' });
    put(doc, money(i.unitPrice, s.style), 350, ry, { size: 10.5, width: 90, align: 'right' });
    put(doc, money(i.amount, s.style), 450, ry, { size: 10.5, width: 95, align: 'right' });
    ry += 24;
  }
  rule(doc, ry);
  ry += 12;
  put(doc, 'Subtotal', 350, ry, { width: 90 });
  put(doc, money(t.subtotal, s.style), 450, ry, { width: 95, align: 'right' });
  put(doc, s.taxLabel, 350, ry + 16, { width: 100 });
  put(doc, money(t.tax, s.style), 450, ry + 16, { width: 95, align: 'right' });
  put(doc, 'Amount due', 350, ry + 44, { size: 13, bold: true, width: 100 });
  put(doc, money(t.total, s.style), 450, ry + 44, {
    size: 13,
    bold: true,
    width: 95,
    align: 'right',
  });
  put(doc, s.footer, 50, 790, { size: 8.5, color: '#777777', width: 495 });
}

function layoutC(doc: Doc, s: Spec) {
  const t = totals(s);
  put(doc, 'From', 50, 50, { size: 8, color: '#777777' });
  put(doc, s.vendor, 50, 62, { size: 13, bold: true });
  s.vendorLines.forEach((l, i) => put(doc, l, 50, 80 + i * 12, { size: 9.5 }));
  put(doc, 'INVOICE', 350, 50, { size: 20, bold: true, width: 195, align: 'right' });
  put(doc, `Invoice no. ${s.number}`, 350, 78, { size: 10, width: 195, align: 'right' });
  put(doc, `Date of issue: ${dateText(s.date, s.dateStyle)}`, 350, 92, {
    size: 10,
    width: 195,
    align: 'right',
  });
  put(doc, `Pay by: ${dateText(s.due, s.dateStyle)}`, 350, 106, {
    size: 10,
    width: 195,
    align: 'right',
  });

  put(doc, 'Bill to', 50, 150, { size: 8, color: '#777777' });
  put(doc, s.customer, 50, 162, { size: 11, bold: true });
  s.customerLines.forEach((l, i) => put(doc, l, 50, 177 + i * 12, { size: 9.5 }));

  put(doc, 'Services and goods', 50, 240, { size: 9, bold: true });
  put(doc, 'Price each', 350, 240, { size: 9, bold: true, width: 90, align: 'right' });
  put(doc, 'Line total', 450, 240, { size: 9, bold: true, width: 95, align: 'right' });
  rule(doc, 254);
  let y = 264;
  for (const i of t.printed) {
    put(doc, `${qty(i.quantity, s.style)} x ${i.description}`, 50, y, { width: 295 });
    put(doc, money(i.unitPrice, s.style), 350, y, { width: 90, align: 'right' });
    put(doc, money(i.amount, s.style), 450, y, { width: 95, align: 'right' });
    y += 20;
  }
  rule(doc, y + 2);
  y += 14;
  put(doc, 'Net total', 350, y, { width: 90 });
  put(doc, money(t.subtotal, s.style), 450, y, { width: 95, align: 'right' });
  put(doc, s.taxLabel, 350, y + 16, { width: 90 });
  put(doc, money(t.tax, s.style), 450, y + 16, { width: 95, align: 'right' });
  put(doc, `Total payable (${s.currency})`, 330, y + 40, {
    size: 11,
    bold: true,
    width: 110,
    align: 'right',
  });
  put(doc, money(t.total, s.style), 450, y + 40, {
    size: 11,
    bold: true,
    width: 95,
    align: 'right',
  });
  put(doc, s.footer, 50, 780, { size: 8.5, color: '#777777', width: 495 });
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'samples'), { recursive: true });
mkdirSync(join(root, 'evals'), { recursive: true });

const expected = [];
for (const s of specs) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: s.number ? `Invoice ${s.number}` : 'Invoice',
      Author: s.vendor,
      Producer: 'pdfkit',
      CreationDate: new Date(`${s.date}T09:00:00Z`),
    },
  });
  doc.pipe(createWriteStream(join(root, 'samples', s.file)));
  if (s.layout === 'A') layoutA(doc, s);
  else if (s.layout === 'B') layoutB(doc, s);
  else layoutC(doc, s);
  doc.end();

  const t = totals(s);
  const flaw = s.hiddenItem ? 'subtotal' : s.number === null ? 'invoiceNumber' : null;
  expected.push({
    file: s.file,
    layout: s.layout,
    fields: {
      vendor: s.vendor,
      invoiceNumber: s.number,
      invoiceDate: s.date,
      dueDate: s.due,
      currency: s.currency,
      subtotal: t.subtotal,
      tax: t.tax,
      total: t.total,
    },
    lineItems: t.printed.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      amount: i.amount,
    })),
    expectedFlag: flaw,
  });
}
writeFileSync(join(root, 'evals', 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
console.log(`wrote ${specs.length} samples and evals/expected.json`);
