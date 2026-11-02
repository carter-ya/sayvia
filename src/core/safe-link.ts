// Only explicit user-activated web links are navigable in a reading preview.
export function safeWebLink(value: string, base?: string) {
  if (
    !value ||
    value.length > 2048 ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    return undefined;
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
