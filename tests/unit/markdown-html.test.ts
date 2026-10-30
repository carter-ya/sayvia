import { expect, it, vi } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';
import {
  createTranslationPlan,
  reconstructTranslation,
  translationPayload,
} from '../../src/core/translation-plan';
import { planResponse } from '../fixtures/plan-response';

it.each([
  'Before <span>FIRST_SECRET\n\nSECOND_SECRET</span> after',
  'Before <span title="a>b">FIRST_SECRET</span> after',
  'Before <span>FIRST_SECRET\n\nSECOND_SECRET',
  'Before <span>FIRST_SECRET<script>const value="</span>";</script>SECOND_SECRET</span> after',
  'Before <span>FIRST_SECRET<!-- </span> -->SECOND_SECRET</span> after',
  'Before <span>FIRST_SECRET ![x </span>](image.png)\n\nSECOND_SECRET</span> after',
  'Before <tr>FIRST_SECRET\n\nSECOND_SECRET</tr> after',
  'Before <span/>FIRST_SECRET after',
])('protects an entire embedded HTML range: %s', (source) => {
  const plan = createTranslationPlan({ kind: 'markdown', text: source });
  expect(JSON.stringify(translationPayload(plan))).not.toMatch(/FIRST_SECRET|SECOND_SECRET/);
  expect(reconstructTranslation(plan, planResponse(plan))).toBe(source);
  const output = reconstructTranslation(
    plan,
    planResponse(plan, () => 'Translated'),
  );
  expect(output).toContain('FIRST_SECRET');
  if (source.includes('SECOND_SECRET')) expect(output).toContain('SECOND_SECRET');
});

it('does not treat code-contained tags as active HTML or load resources', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  try {
    const source =
      'Read `<span>CODE_SECRET</span>` and <img src="https://example.test/image.png"> after.';
    const plan = createTranslationPlan({ kind: 'markdown', text: source });
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/CODE_SECRET|image.png/);
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(source);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('bundles the full translation core for a browser worker without Node runtime dependencies', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: resolve('src/core/translation-plan.ts'), formats: ['es'] },
      minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const code = outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .filter((item) => item.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('\n');
  expect(code.length).toBeGreaterThan(0);
  expect(code).not.toContain('__vite-browser-external');
});
