import { parseExtraction } from '../validate.js';
import type { Extraction, Extractor } from '../types.js';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class ExtractionError extends Error {}

const SYSTEM = `You extract structured data from the text of one invoice.
Reply with JSON only, in exactly this shape:
{"fields": {
  "vendor": {"value": string|null, "source": string|null},
  "invoiceNumber": {"value": string|null, "source": string|null},
  "invoiceDate": {"value": "YYYY-MM-DD"|null, "source": string|null},
  "dueDate": {"value": "YYYY-MM-DD"|null, "source": string|null},
  "currency": {"value": "3-letter ISO code"|null, "source": string|null},
  "subtotal": {"value": number|null, "source": string|null},
  "tax": {"value": number|null, "source": string|null},
  "total": {"value": number|null, "source": string|null}},
 "lineItems": [{"description": string, "quantity": number, "unitPrice": number, "amount": number, "source": string}]}
Rules: copy every number exactly as printed, do not calculate or correct anything. "source" is a verbatim excerpt of the
document text that the value was read from. If a field is not in the document, use null. Never invent a value.`;

export function parseModelJson(content: string): Extraction {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  let data: unknown;
  try {
    data = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ExtractionError('The model returned malformed JSON.');
  }
  return parseExtraction(data);
}

// Works with any OpenAI-compatible chat completions endpoint.
export class LlmExtractor implements Extractor {
  readonly name: string;

  constructor(private readonly config: LlmConfig) {
    this.name = `llm:${config.model}`;
  }

  async extract(text: string): Promise<Extraction> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const response = await doFetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Invoice text:\n\n${text}` },
        ],
      }),
    });
    if (!response.ok)
      throw new ExtractionError(`LLM request failed with status ${response.status}.`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return parseModelJson(body.choices?.[0]?.message?.content ?? '');
  }
}
