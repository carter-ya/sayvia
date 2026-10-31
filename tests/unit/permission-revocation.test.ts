import { expect, it } from 'vitest';
import { matchesHostOrigin } from '../../src/background/permission-revocation';
it.each([
  ['https://a.example/*', 'https://a.example:8443', true],
  ['https://a.example/*', 'https://b.example', false],
  ['https://a.example/*', 'http://a.example', false],
  ['*://*.a.example/*', 'http://a.example', true],
  ['*://*.a.example/*', 'https://child.a.example', true],
  ['*://*.a.example/*', 'https://fake-a.example', false],
  ['https://*/*', 'https://b.example', true],
  ['<all_urls>', 'http://localhost:9123', true],
  ['invalid', 'https://a.example', false],
])('matches revoked host %s against %s', (pattern, origin, expected) => {
  expect(matchesHostOrigin(pattern, origin)).toBe(expected);
});
