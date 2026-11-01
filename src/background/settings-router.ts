import { RequestSchema } from '../storage/schema';
import type { TaskBroker } from './task-broker';
import type { ConfigRepository } from '../storage/repository';

const PUBLIC_ERRORS = new Set(['CONFLICT', 'NOT_FOUND', 'CONFIG_UNAVAILABLE']);

export async function handleSettings(
  message: unknown,
  repository: ConfigRepository,
  broker?: Pick<TaskBroker, 'clearAll'>,
) {
  const parsed = RequestSchema.safeParse(message);
  if (!parsed.success) return { ok: false as const, error: 'INVALID_REQUEST' };
  try {
    const request = parsed.data;
    let data;
    switch (request.type) {
      case 'settings.read':
        data = await repository.snapshot();
        break;
      case 'settings.save':
        data = await repository.save(request.payload);
        break;
      case 'settings.preferences':
        data = await repository.preferences(request.payload);
        break;
      case 'settings.delete':
        data = await repository.delete(request.payload.id, request.payload.expectedRevision);
        break;
      case 'settings.clear':
        if (!broker) throw new Error('CONFIG_UNAVAILABLE');
        data = await broker.clearAll(() => repository.clear(request.payload.expectedRevision));
        break;
    }
    return { ok: true as const, data };
  } catch (error) {
    const code =
      error instanceof Error && PUBLIC_ERRORS.has(error.message)
        ? error.message
        : 'CONFIG_UNAVAILABLE';
    return {
      ok: false as const,
      error:
        parsed.data.type === 'settings.clear' && code === 'CONFIG_UNAVAILABLE'
          ? 'CLEAR_INCOMPLETE'
          : code,
    };
  }
}
