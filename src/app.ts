import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import multer from 'multer';
import { ExtractionError } from './extract/llm.js';
import { InputError, pdfToText } from './ingest.js';
import type { Pipeline } from './pipeline.js';
import { parseExtraction, SchemaError, validate } from './validate.js';

const WINDOW_MS = 60_000;
const MIN_TEXT = 20;
const MAX_TEXT = 100_000;
const MAX_PDF_BYTES = 2 * 1024 * 1024;

function limiter(maxPerWindow: number) {
  const seen = new Map<string, { count: number; resetAt: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const entry = seen.get(ip);
    if (!entry || entry.resetAt < now) {
      seen.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= maxPerWindow;
  };
}

export function createApp(pipeline: Pipeline, root: string) {
  const app = express();
  const extractAllowed = limiter(20);
  const validateAllowed = limiter(240);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PDF_BYTES, files: 1 },
  });
  const sampleDir = join(root, 'samples');
  const sampleText = new Map<string, string>();

  const sampleIds = () =>
    existsSync(sampleDir)
      ? readdirSync(sampleDir)
          .filter((f) => f.endsWith('.pdf'))
          .map((f) => f.slice(0, -4))
          .sort()
      : [];

  const titles = (): Map<string, string> => {
    const file = join(root, 'evals', 'expected.json');
    if (!existsSync(file)) return new Map();
    const rows = JSON.parse(readFileSync(file, 'utf8')) as {
      file: string;
      fields: { vendor: string };
    }[];
    return new Map(rows.map((r) => [r.file.slice(0, -4), r.fields.vendor]));
  };

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(join(root, 'public')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: pipeline.mode });
  });

  app.get('/api/eval', (_req, res) => {
    const file = join(root, 'evals', 'last-report.json');
    if (!existsSync(file)) {
      res.status(404).json({ error: 'No eval report yet. Run npm run eval.' });
      return;
    }
    res.type('json').send(readFileSync(file, 'utf8'));
  });

  app.get('/api/samples', (_req, res) => {
    const names = titles();
    res.json(sampleIds().map((id) => ({ id, title: names.get(id) ?? id })));
  });

  app.get('/api/samples/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!sampleIds().includes(id)) {
      res.status(404).json({ error: 'Unknown sample.' });
      return;
    }
    let text = sampleText.get(id);
    if (text === undefined) {
      text = await pdfToText(readFileSync(join(sampleDir, `${id}.pdf`)));
      sampleText.set(id, text);
    }
    res.json({ id, text });
  });

  app.post('/api/validate', (req, res) => {
    if (!validateAllowed(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
      return;
    }
    try {
      res.json(validate(parseExtraction(req.body)));
    } catch (error) {
      if (error instanceof SchemaError) {
        res.status(422).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.post('/api/extract', upload.single('file'), async (req, res) => {
    if (!extractAllowed(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
      return;
    }
    try {
      let text: string;
      if (req.file) {
        const head = req.file.buffer.subarray(0, 5).toString('latin1');
        if (head !== '%PDF-') throw new InputError('The uploaded file is not a PDF.');
        text = await pdfToText(req.file.buffer);
        if (text.length < MIN_TEXT) {
          throw new InputError(
            'The PDF has no readable text layer. Scanned documents need OCR, which is not supported.'
          );
        }
      } else if (typeof req.body?.text === 'string') {
        text = req.body.text.replace(/\r\n/g, '\n').trim();
        if (text.length < MIN_TEXT || text.length > MAX_TEXT) {
          throw new InputError(
            `Send between ${MIN_TEXT} and ${MAX_TEXT} characters of invoice text.`
          );
        }
      } else {
        throw new InputError('Send a PDF as multipart field "file", or JSON {"text": "..."}.');
      }
      res.json(await pipeline.run(text));
    } catch (error) {
      if (error instanceof InputError) {
        res.status(422).json({ error: error.message });
      } else if (error instanceof ExtractionError || error instanceof SchemaError) {
        console.error(error);
        res
          .status(502)
          .json({ error: `The extraction service gave an unusable answer: ${error.message}` });
      } else {
        console.error(error);
        res.status(502).json({ error: 'The extraction service is unavailable right now.' });
      }
    }
  });

  app.use(
    (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'The PDF is larger than 2 MB.'
            : 'Upload one PDF in the multipart field "file".';
        res.status(422).json({ error: message });
        return;
      }
      if (err instanceof SyntaxError) {
        res.status(422).json({ error: 'The request body is not valid JSON.' });
        return;
      }
      next(err);
    }
  );

  return app;
}
