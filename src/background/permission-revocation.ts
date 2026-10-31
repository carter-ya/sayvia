// Chrome host permissions ignore URL path and port. Only browser-reported
// removed patterns are used here; a task keeps its original host snapshot.
export function matchesHostOrigin(pattern: string, origin: string) {
  try {
    const target = new URL(origin);
    if (pattern === '<all_urls>') return ['https:', 'http:'].includes(target.protocol);
    const anyScheme = pattern.startsWith('*://');
    const permission = new URL(anyScheme ? `https:${pattern.slice(2)}` : pattern);
    const host = permission.hostname;
    return (
      (anyScheme
        ? ['https:', 'http:'].includes(target.protocol)
        : permission.protocol === target.protocol) &&
      (host === '*' ||
        host === target.hostname ||
        (host.startsWith('*.') &&
          (target.hostname === host.slice(2) || target.hostname.endsWith(`.${host.slice(2)}`))))
    );
  } catch {
    return false;
  }
}
