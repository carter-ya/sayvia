import { z } from 'zod';
import { readCompletionStream, tokenUsage } from './completion-stream';
import { chatCompletionsEndpoint } from './endpoint';
import type { TokenUsage } from '../runtime/translation-progress';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const EXECUTION_BUDGET_MS = 60_000;
export type ProviderErrorCode =
  | 'CONFIG_REQUIRED'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'UNSUPPORTED_RESPONSE'
  | 'FORMAT_INVALID'
  | 'CANCELED';
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(code);
  }
}
export const ConfigSchema = z
  .object({
    baseUrl: z.string().min(1).max(2048),
    model: z.string().trim().min(1).max(160),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .refine((value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 33 && character.charCodeAt(0) <= 126,
        ),
      ),
  })
  .strict();
export type CompletionConfig = z.infer<typeof ConfigSchema>;
const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        finish_reason: z.literal('stop'),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().trim().min(1),
          refusal: z.string().nullable().optional(),
          tool_calls: z.array(z.unknown()).max(0).nullish(),
          function_call: z.null().optional(),
        }),
      }),
    )
    .length(1),
});
async function readLimited(response: Response) {
  if (!response.body) throw new ProviderError('UNSUPPORTED_RESPONSE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ProviderError('UNSUPPORTED_RESPONSE');
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('UNSUPPORTED_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}

async function httpError(response: Response): Promise<never> {
  let code: ProviderErrorCode = 'NETWORK_ERROR';
  if (response.status === 401 || response.status === 403) code = 'AUTH_FAILED';
  else if (response.status === 402) code = 'QUOTA_EXCEEDED';
  else if (response.status === 404) code = 'MODEL_UNAVAILABLE';
  else if (response.status === 408 || response.status === 504) code = 'TIMEOUT';
  else if (response.status === 429) {
    code = 'RATE_LIMITED';
    try {
      const json: unknown = JSON.parse(await readLimited(response));
      const error = z
        .object({ error: z.object({ code: z.enum(['insufficient_quota', 'quota_exceeded']) }) })
        .safeParse(json);
      if (error.success) code = 'QUOTA_EXCEEDED';
    } catch {
      /* Only an allowlisted code may leave the response boundary. */
    }
  }
  if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
  throw new ProviderError(code);
}

export interface PreparedCompletion {
  config: CompletionConfig;
  endpoint: string;
  body: string;
  inputTokens: number;
}

// Only trusted processors supply instructions and payloads; page messages never do.
export function prepareCompletion(
  input: CompletionConfig,
  instruction: string,
  payload: unknown,
  stream = true,
): PreparedCompletion {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new ProviderError('CONFIG_REQUIRED');
  const config = parsed.data;
  const endpoint = chatCompletionsEndpoint(config.baseUrl);
  const body = JSON.stringify({
    model: config.model,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages: [
      { role: 'system', content: instruction },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });
  return {
    config,
    endpoint,
    body,
    inputTokens: Math.ceil(new TextEncoder().encode(body).length / 4),
  };
}

// The caller owns the deadline, cancellation, schema validation and processor lifetime.
// Credential checks belong to decoded display fields, never the JSON envelope or field names.
// onContent contains untrusted model JSON: never pass it directly to a UI.
export async function sendCompletion(
  request: PreparedCompletion,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onContent: (
    content: string,
    reasoning: number,
    usage?: TokenUsage,
  ) => Promise<void> = async () => {},
) {
  if (signal.aborted) throw new ProviderError('CANCELED');
  const response = await fetcher(request.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.config.apiKey}`,
      'Content-Type': 'application/json',
    },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal,
    body: request.body,
  });
  if (!response.ok) await httpError(response);
  const streamed =
    response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false;
  let content: string;
  let usage: TokenUsage | undefined;
  if (streamed) {
    const result = await readCompletionStream(
      response,
      MAX_STREAM_BYTES,
      onContent,
      MAX_RESPONSE_BYTES,
    );
    content = result.content;
    usage = result.usage;
  } else {
    const raw = await readLimited(response);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ProviderError('UNSUPPORTED_RESPONSE');
    }
    const completion = CompletionSchema.safeParse(json);
    if (!completion.success || completion.data.choices[0]!.message.refusal)
      throw new ProviderError('UNSUPPORTED_RESPONSE');
    content = completion.data.choices[0]!.message.content;
    usage = tokenUsage((json as { usage?: unknown }).usage);
  }
  return { content, streamed, ...(usage ? { usage } : {}) };
}
