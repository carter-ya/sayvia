import { describe, expect, it } from 'vitest';
import {
  LANGUAGES,
  canonicalLanguage,
  languageName,
  searchLanguages,
} from '../../src/ui/languages';
describe('searchable language catalogue', () => {
  it('sorts every language by its English name with stable tag ties', () => {
    const collator = new Intl.Collator('en', { sensitivity: 'base' });
    for (let i = 1; i < LANGUAGES.length; i++)
      expect(
        collator.compare(LANGUAGES[i - 1]!.english, LANGUAGES[i]!.english),
      ).toBeLessThanOrEqual(0);
    expect(new Set(LANGUAGES.map((x) => x.code)).size).toBe(LANGUAGES.length);
  });
  it('searches native names, English names and case-insensitive BCP-47 aliases', () => {
    for (const [query, code] of [
      ['日语', 'ja'],
      ['日本語', 'ja'],
      ['French', 'fr'],
      ['zh-hans', 'zh-Hans'],
      ['zh_CN', 'zh-Hans'],
      ['en-US', 'en-US'],
      ['es', 'es'],
    ] as const)
      expect(searchLanguages(query).map((x) => x.code)).toContain(code);
    expect(searchLanguages('es').map((x) => x.code)).toEqual(['es']);
    expect(searchLanguages('francais').map((x) => x.code)).toContain('fr');
  });
  it('keeps automatic detection out of target choices and never duplicates it', () => {
    expect(searchLanguages('', true)[0]!.code).toBe('auto');
    expect(searchLanguages('auto', true).map((x) => x.code)).toEqual(['auto']);
    expect(searchLanguages('auto')).toEqual([]);
  });
  it('accepts canonical custom tags without inventing tags from search words', () => {
    expect(canonicalLanguage('de-CH-1996')).toBe('de-CH-1996');
    expect(searchLanguages('de-CH-1996').at(-1)!.code).toBe('de-CH-1996');
    expect(canonicalLanguage('French')).toBeUndefined();
    expect(canonicalLanguage('not a language')).toBeUndefined();
    expect(languageName('LegacyLanguage')).toBe('LegacyLanguage');
  });
});
