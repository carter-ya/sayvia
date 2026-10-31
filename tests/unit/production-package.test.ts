import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const output = resolve('.output/chrome-mv3');
const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as {
  manifest_version: number;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: unknown[];
  background: { service_worker: string };
  action: { default_popup: string };
  options_ui: { page: string };
  content_security_policy: { extension_pages: string };
};

describe('production extension package', () => {
  it('does not grant website access before a feature needs it', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions ?? []).toEqual(['storage', 'offscreen']);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toEqual([
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
    expect(manifest.content_scripts ?? []).toEqual([]);
  });

  it('ships its real browser entrypoints and a separately bundled worker', () => {
    for (const file of [
      manifest.background.service_worker,
      manifest.action.default_popup,
      manifest.options_ui.page,
      'offscreen.html',
      'content-scripts/translator.js',
    ])
      expect(existsSync(join(output, file))).toBe(true);
    const files = readdirSync(output, { recursive: true }).map(String);
    expect(files.some((file) => /bootstrap\.worker.*\.js$/.test(file))).toBe(true);
  });

  it('permits local workers without remote scripts or eval', () => {
    const policy = manifest.content_security_policy.extension_pages;
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).not.toMatch(/unsafe-eval|unsafe-inline|https?:/);
  });
});
