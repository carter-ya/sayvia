import { z } from 'zod';

// Chrome host permissions cover every path and port, but not sibling subdomains.
export function siteOrigin(value: string) {
  const url = new URL(value);
  if (
    url.hostname.includes('*') ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    throw new Error('INVALID_SITE');
  return `${url.protocol}//${url.hostname}`;
}
export const SiteRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings.sites.read') }).strict(),
  z
    .object({
      type: z.literal('settings.sites.set'),
      payload: z
        .object({
          origin: z
            .string()
            .max(2048)
            .transform((value, ctx) => {
              try {
                return siteOrigin(value);
              } catch {
                ctx.addIssue({ code: 'custom', message: 'Invalid website' });
                return z.NEVER;
              }
            }),
          enabled: z.boolean(),
          expectedRevision: z.int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
]);
export const SitesView = z
  .object({
    sites: z.array(
      z
        .object({
          origin: z.string(),
          active: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
