import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfToText } from './ingest.js';
import { createPipeline } from './pipeline.js';
import { FIELD_NAMES, type FieldName } from './types.js';

interface Expected {
  file: string;
  layout: string;
  fields: Record<FieldName, string | number | null>;
  lineItems: { description: string; quantity: number; unitPrice: number; amount: number }[];
  expectedFlag: string | null;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const samples = JSON.parse(
  readFileSync(join(root, 'evals', 'expected.json'), 'utf8')
) as Expected[];
const pipeline = createPipeline();

const same = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number'
    ? Math.abs(a - b) < 1e-9
    : (a ?? null) === (b ?? null);

const misses: string[] = [];
const fieldHits = Object.fromEntries(FIELD_NAMES.map((n) => [n, 0])) as Record<FieldName, number>;
let itemsExpected = 0;
let itemsMatched = 0;
let itemsExtra = 0;
let flawed = 0;
let flawedCaught = 0;
let clean = 0;
let falseAlarms = 0;
const rows = [];

for (const s of samples) {
  const text = await pdfToText(readFileSync(join(root, 'samples', s.file)));
  const result = await pipeline.run(text);
  const v = result.validation;

  const fieldOk: Record<string, boolean> = {};
  for (const name of FIELD_NAMES) {
    const got = v.fields[name].value;
    fieldOk[name] = same(got, s.fields[name]);
    if (fieldOk[name]) fieldHits[name] += 1;
    else
      misses.push(
        `${s.file}  ${name}: expected ${JSON.stringify(s.fields[name])}, got ${JSON.stringify(got)}`
      );
  }

  const pool = [...v.lineItems];
  for (const want of s.lineItems) {
    itemsExpected += 1;
    const at = pool.findIndex(
      (g) =>
        g.description === want.description &&
        same(g.quantity, want.quantity) &&
        same(g.unitPrice, want.unitPrice) &&
        same(g.amount, want.amount)
    );
    if (at >= 0) {
      itemsMatched += 1;
      pool.splice(at, 1);
    } else {
      misses.push(`${s.file}  line item not extracted exactly: ${JSON.stringify(want)}`);
    }
  }
  itemsExtra += pool.length;
  for (const extra of pool)
    misses.push(`${s.file}  unexpected line item: ${JSON.stringify(extra.description)}`);

  let flagged: boolean | null = null;
  if (s.expectedFlag) {
    flawed += 1;
    const field = v.fields[s.expectedFlag as FieldName];
    flagged = !v.valid && field.status !== 'ok';
    if (flagged) flawedCaught += 1;
    else misses.push(`${s.file}  flawed document not flagged on ${s.expectedFlag}`);
  } else {
    clean += 1;
    if (!v.valid) {
      falseAlarms += 1;
      misses.push(`${s.file}  clean document flagged: ${v.issues.join(' | ')}`);
    }
  }
  rows.push({
    file: s.file,
    layout: s.layout,
    fieldOk,
    valid: v.valid,
    issues: v.issues,
    expectedFlag: s.expectedFlag,
    flagged,
  });
}

const total = samples.length;
const fieldCells = total * FIELD_NAMES.length;
const fieldHitTotal = Object.values(fieldHits).reduce((a, b) => a + b, 0);
const metrics = {
  samples: total,
  fieldAccuracy: fieldHitTotal / fieldCells,
  perField: Object.fromEntries(FIELD_NAMES.map((n) => [n, fieldHits[n] / total])),
  lineItemAccuracy: itemsMatched / itemsExpected,
  lineItemsExpected: itemsExpected,
  lineItemsMatched: itemsMatched,
  lineItemsExtra: itemsExtra,
  flawedDocuments: flawed,
  flawedFlagged: flawedCaught,
  cleanDocuments: clean,
  cleanFalselyFlagged: falseAlarms,
};

const report = { mode: pipeline.mode, ranAt: new Date().toISOString(), metrics, misses, rows };
writeFileSync(join(root, 'evals', 'last-report.json'), JSON.stringify(report, null, 2) + '\n');

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`mode: ${pipeline.mode}   samples: ${total}\n`);
console.log('field            correct  accuracy');
for (const n of FIELD_NAMES) {
  console.log(
    `${n.padEnd(16)} ${`${fieldHits[n]}/${total}`.padEnd(8)} ${pct(fieldHits[n] / total)}`
  );
}
console.log(
  `${'ALL FIELDS'.padEnd(16)} ${`${fieldHitTotal}/${fieldCells}`.padEnd(8)} ${pct(metrics.fieldAccuracy)}\n`
);
console.log(
  `line items exact:   ${itemsMatched}/${itemsExpected} (${pct(metrics.lineItemAccuracy)}), extra rows: ${itemsExtra}`
);
console.log(`flawed flagged:     ${flawedCaught}/${flawed}`);
console.log(`clean false alarms: ${falseAlarms}/${clean}\n`);
if (misses.length) {
  console.log(`misses (${misses.length}):`);
  for (const m of misses) console.log(`  MISS  ${m}`);
} else {
  console.log('misses: none');
}

const FIELD_FLOOR = 0.85;
const failed =
  metrics.fieldAccuracy < FIELD_FLOOR ||
  metrics.lineItemAccuracy < FIELD_FLOOR ||
  flawedCaught < flawed ||
  falseAlarms > 0;
if (failed) {
  console.error(
    `\n[FAIL] field/line accuracy below ${FIELD_FLOOR}, a flawed document slipped through, or a clean one was flagged`
  );
  process.exit(1);
}
console.log(`\n[PASS] accuracy >= ${FIELD_FLOOR}, every flawed document flagged, no false alarms`);
