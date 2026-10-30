import { RequestSchema } from '../storage/schema';
import type { ConfigRepository } from '../storage/repository';

const PUBLIC_ERRORS = new Set(['CONFLICT', 'NOT_FOUND', 'CONFIG_UNAVAILABLE']);

export async function handleSettings(message: unknown, repository: ConfigRepository) {
  const parsed = RequestSchema.safeParse(message);
  if (!parsed.success) return { ok: false as const, error: 'INVALID_REQUEST' };
  try {
    const request = parsed.data;
    const data =
      request.type === 'settings.read'
        ? await repository.snapshot()
        : request.type === 'settings.save'
          ? await repository.save(request.payload)
          : await repository.delete(request.payload.id, request.payload.expectedRevision);
    return { ok: true as const, data };
  } catch (error) {
    const code =
      error instanceof Error && PUBLIC_ERRORS.has(error.message)
        ? error.message
        : 'CONFIG_UNAVAILABLE';
    return { ok: false as const, error: code };
  }
}
