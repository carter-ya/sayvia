import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TranslationMetrics } from '../../src/ui/TranslationMetrics';
import type { TranslationProgress } from '../../src/runtime/translation-progress';

function render(phase: TranslationProgress['phase'], elapsedMs = 9000) {
  return renderToStaticMarkup(
    createElement(TranslationMetrics, {
      busy: true,
      progress: { phase, elapsedMs, text: '', estimates: { inputTokens: 768, outputTokens: 0 } },
    }),
  );
}
describe('translation wait feedback', () => {
  it('explains a slow service response without claiming a connection failure', () => {
    expect(render('connecting')).toContain('等待服务响应');
    expect(render('connecting')).toContain('可能与网络、服务排队或模型处理有关');
    expect(render('connecting', 1000)).not.toContain('可继续等待');
  });
  it('distinguishes headers received from model reasoning and removes wait hints during output', () => {
    expect(render('waiting')).toContain('已收到服务响应，模型尚未返回译文');
    expect(render('thinking')).toContain('模型正在推理');
    expect(render('translating')).not.toContain('可继续等待');
    expect(render('validating')).not.toContain('可继续等待');
  });
  it('retains measured response/output times after completion and accepts older results', () => {
    const result = {
      requested: true,
      durationMs: 5000,
      timing: { responseHeadersMs: 1200, firstContentMs: 3400 },
    };
    const markup = renderToStaticMarkup(createElement(TranslationMetrics, { busy: false, result }));
    expect(markup).toContain('首次输出 3.4 s');
    expect(markup).not.toContain('可继续等待');
    expect(
      renderToStaticMarkup(
        createElement(TranslationMetrics, {
          busy: false,
          result: { requested: true, durationMs: 1000 },
        }),
      ),
    ).toContain('已完成');
  });
});
