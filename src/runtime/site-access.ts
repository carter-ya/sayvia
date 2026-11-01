// Chrome host permissions cover every path and port, but not sibling subdomains.
export function siteOrigin(value: string) {
  const url = new URL(value);
  if (
    url.hostname.includes('*') ||
    url.username ||
    url.password ||
    !['https:', 'http:'].includes(url.protocol)
  )
    throw new Error('INVALID_SITE');
  return `${url.protocol}//${url.hostname}`;
}
