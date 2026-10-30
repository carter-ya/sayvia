import type { TranslationPlan } from '../../src/core/translation-plan';

export function planResponse(plan: TranslationPlan, transform = (text: string) => text) {
  return JSON.stringify({
    segments: plan.segments.map((segment) => ({
      id: segment.id,
      text: segment.text
        .split(/(⟦SV\d+:\d+⟧)/)
        .map((piece) => {
          if (segment.tokens.some((token) => token.marker === piece)) return piece;
          const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(piece)!;
          return match[2] ? match[1] + transform(match[2]) + match[3] : piece;
        })
        .join(''),
    })),
  });
}
