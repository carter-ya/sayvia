import { UsageSchema, type TokenUsage } from '../runtime/translation-progress';
export class StreamError extends Error {}
export function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  const details = raw.completion_tokens_details as Record<string, unknown> | undefined;
  const parsed = UsageSchema.safeParse({
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens,
    ...(details?.reasoning_tokens !== undefined
      ? { reasoningTokens: details.reasoning_tokens }
      : {}),
  });
  if (
    parsed.success &&
    parsed.data.inputTokens + parsed.data.outputTokens === parsed.data.totalTokens &&
    (parsed.data.reasoningTokens ?? 0) <= parsed.data.outputTokens
  )
    return parsed.data;
  return undefined;
}
export async function readCompletionStream(
  response: Response,
  maximum: number,
  progress: (content: string, reasoningCharacters: number, usage?: TokenUsage) => Promise<void>,
) {
  if (!response.body) throw new StreamError();
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    buffer = '',
    data: string[] = [],
    content = '',
    reasoningCharacters = 0,
    finished = false,
    done = false,
    usage: TokenUsage | undefined;
  const dispatch = async () => {
    if (!data.length) return;
    const raw = data.join('\n');
    data = [];
    if (raw === '[DONE]') {
      if (!finished || !content.trim()) throw new StreamError();
      done = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StreamError();
    }
    if (!parsed || typeof parsed !== 'object') throw new StreamError();
    const event = parsed as {
      object?: unknown;
      choices?: unknown;
      usage?: unknown;
      error?: unknown;
    };
    if (
      event.error ||
      (event.object !== undefined && event.object !== 'chat.completion.chunk') ||
      !Array.isArray(event.choices) ||
      event.choices.length > 1
    )
      throw new StreamError();
    if (!event.choices.length) {
      if (!finished) throw new StreamError();
    } else {
      const choice = event.choices[0] as {
        index?: unknown;
        delta?: Record<string, unknown>;
        finish_reason?: unknown;
      };
      if (
        !choice ||
        choice.index !== 0 ||
        !choice.delta ||
        typeof choice.delta !== 'object' ||
        Array.isArray(choice.delta)
      )
        throw new StreamError();
      const delta = choice.delta;
      if (
        (delta.role !== undefined && delta.role !== 'assistant') ||
        delta.refusal ||
        delta.function_call ||
        delta.audio ||
        (delta.tool_calls !== undefined &&
          delta.tool_calls !== null &&
          (!Array.isArray(delta.tool_calls) || delta.tool_calls.length))
      )
        throw new StreamError();
      if (
        delta.content !== undefined &&
        delta.content !== null &&
        typeof delta.content !== 'string'
      )
        throw new StreamError();
      if (
        delta.reasoning_content !== undefined &&
        delta.reasoning_content !== null &&
        typeof delta.reasoning_content !== 'string'
      )
        throw new StreamError();
      const text = typeof delta.content === 'string' ? delta.content : '';
      if (finished && (text || delta.reasoning_content)) throw new StreamError();
      content += text;
      reasoningCharacters +=
        typeof delta.reasoning_content === 'string' ? [...delta.reasoning_content].length : 0;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (choice.finish_reason !== 'stop' || finished) throw new StreamError();
        finished = true;
      }
    }
    if (finished) usage = tokenUsage(event.usage) ?? usage;
    await progress(content, reasoningCharacters, usage);
  };
  const lines = async (final = false) => {
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (!line) await dispatch();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      if (done) return;
    }
    if (final && buffer) {
      const line = buffer.replace(/\r$/, '');
      buffer = '';
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (final) await dispatch();
  };
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        await lines(true);
        break;
      }
      size += next.value.byteLength;
      if (size > maximum) throw new StreamError();
      buffer += decoder.decode(next.value, { stream: true });
      await lines();
    }
    if (!done) throw new StreamError();
    await reader.cancel().catch(() => undefined);
    return { content, usage };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof StreamError) throw error;
    throw new StreamError();
  } finally {
    reader.releaseLock();
  }
}
