export type CaptionWord = { text: string; lookup: boolean };

// Segmentation suggests a selectable word, not an authoritative dictionary form.
// Unsupported locale/engine leaves the exact original text readable.
export function captionWords(text: string, language: string): CaptionWord[] {
  try {
    if (!Intl.Segmenter.supportedLocalesOf([language]).length) return [{ text, lookup: false }];
    const segmenter = new Intl.Segmenter(language, { granularity: 'word' });
    const parts = [...segmenter.segment(text)].map((part) => ({
      text: part.segment,
      lookup: !!part.isWordLike && [...part.segment].length <= 80,
    }));
    // Bound interactive DOM without truncating any caption text.
    return parts.filter((part) => part.lookup).length > 256 ? [{ text, lookup: false }] : parts;
  } catch {
    return [{ text, lookup: false }];
  }
}
