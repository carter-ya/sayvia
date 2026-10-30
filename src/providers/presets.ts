export const PROVIDER_PRESETS = Object.freeze({
  openai: Object.freeze({
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'chat-completions',
    instructionRole: 'system',
    verifiedModels: Object.freeze([] as string[]),
  }),
  deepseek: Object.freeze({
    baseUrl: 'https://api.deepseek.com',
    protocol: 'chat-completions',
    instructionRole: 'system',
    verifiedModels: Object.freeze([] as string[]),
  }),
  'openai-compatible': Object.freeze({
    baseUrl: '',
    protocol: 'chat-completions',
    instructionRole: 'system',
    verifiedModels: Object.freeze([] as string[]),
  }),
});
