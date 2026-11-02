import { LANGUAGE_LABELS } from './language-labels';
export interface LanguageOption {
  code: string;
  name: string;
  english: string;
  native: string;
  aliases: string[];
}
const chinese = new Intl.DisplayNames(['zh-Hans'], {
  type: 'language',
  languageDisplay: 'standard',
});
const aliases: Record<string, string[]> = {
  'zh-Hans': ['zh', 'zh-CN', 'zh-SG', '中文', '汉语', '漢語', '简体'],
  'zh-Hant': ['zh', 'zh-TW', 'zh-HK', '中文', '汉语', '漢語', '繁体', '繁體中文'],
  en: ['英语', '英文'],
  ja: ['日语', '日文'],
  ko: ['韩语', '韩文'],
};
const collator = new Intl.Collator('en', { sensitivity: 'base' });
export const LANGUAGES: LanguageOption[] = Object.entries(LANGUAGE_LABELS)
  .map(([code, [name, english, native]]) => ({
    code,
    name,
    english,
    native,
    aliases: aliases[code] ?? [],
  }))
  .sort((a, b) => collator.compare(a.english, b.english) || a.code.localeCompare(b.code, 'en'));
const normalize = (value: string) =>
  value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/_/g, '-');
export function canonicalLanguage(value: string): string | undefined {
  try {
    if (value.trim().length > 40) return;
    if (!/^[a-z]{2,3}(?:-|$)/i.test(value.trim()) || value.trim().toLowerCase() === 'auto') return;
    const tags = Intl.getCanonicalLocales(value.trim());
    return tags.length === 1 ? tags[0] : undefined;
  } catch {
    return undefined;
  }
}
function customDisplayName(code: string) {
  try {
    return chinese.of(code) ?? code;
  } catch {
    return code;
  }
}
export function searchLanguages(query: string, allowAuto = false) {
  const key = normalize(query.trim());
  const exact =
    key && canonicalLanguage(key)
      ? LANGUAGES.filter((language) =>
          [language.code, ...language.aliases].some((value) => normalize(value) === key),
        )
      : [];
  if (exact.length) return exact;
  const options = LANGUAGES.filter((language) =>
    [language.code, language.name, language.native, language.english, ...language.aliases].some(
      (value) => normalize(value).includes(key),
    ),
  );
  if (allowAuto && ['auto', '自动识别', 'detect'].some((value) => normalize(value).includes(key)))
    options.unshift({
      code: 'auto',
      name: '自动识别',
      english: 'Automatic detection',
      native: '',
      aliases: [],
    });
  const custom = canonicalLanguage(query);
  if (
    custom &&
    !LANGUAGES.some((language) =>
      [language.code, ...language.aliases].some((alias) => normalize(alias) === normalize(custom)),
    )
  )
    options.push({
      code: custom,
      name: customDisplayName(custom),
      english: '自定义 BCP-47',
      native: '',
      aliases: [],
    });
  return options;
}
export function languageName(value: string) {
  return value === 'auto'
    ? '自动识别'
    : (LANGUAGES.find((language) => language.code === value)?.name ?? value);
}
