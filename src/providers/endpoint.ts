export class EndpointError extends Error {
  constructor() {
    super('INVALID_ENDPOINT');
  }
}

export function normalizeBaseUrl(value: string) {
  try {
    if (value.length > 2048 || /[\r\n\t?#]/.test(value)) throw new EndpointError();
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    if (
      url.username ||
      url.password ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      ) ||
      decodeURIComponent(path).toLowerCase().endsWith('/chat/completions')
    )
      throw new EndpointError();
    return `${url.origin}${path}`;
  } catch {
    throw new EndpointError();
  }
}

export function chatCompletionsEndpoint(baseUrl: string) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}
