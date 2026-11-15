import { LlmExtractor } from './extract/llm.js';
import { RulesExtractor } from './extract/rules.js';
import { FIELD_NAMES, type Extraction, type Extractor } from './types.js';
import { validate, type Validation } from './validate.js';

export interface Result {
  mode: string;
  text: string;
  validation: Validation;
  ms: number;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// A snippet the extractor claims to have read must actually be in the document.
export function dropUnfoundSources(extraction: Extraction, text: string): Extraction {
  const haystack = squash(text);
  const keep = (s: string | null | undefined) => (s && haystack.includes(squash(s)) ? s : null);
  for (const name of FIELD_NAMES) {
    const f = extraction.fields[name];
    f.source = keep(f.source);
  }
  for (const item of extraction.lineItems) item.source = keep(item.source);
  return extraction;
}

export class Pipeline {
  constructor(private readonly extractor: Extractor) {}

  get mode(): string {
    return this.extractor.name;
  }

  async run(text: string): Promise<Result> {
    const started = performance.now();
    const extraction = dropUnfoundSources(await this.extractor.extract(text), text);
    return {
      mode: this.mode,
      text,
      validation: validate(extraction),
      ms: Math.round(performance.now() - started),
    };
  }
}

export function createPipeline(env: NodeJS.ProcessEnv = process.env): Pipeline {
  if (env.LLM_API_KEY) {
    if (!env.LLM_MODEL) throw new Error('LLM_API_KEY is set but LLM_MODEL is not.');
    return new Pipeline(
      new LlmExtractor({
        apiKey: env.LLM_API_KEY,
        model: env.LLM_MODEL,
        baseUrl: env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1',
      })
    );
  }
  return new Pipeline(new RulesExtractor());
}
