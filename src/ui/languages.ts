export interface LanguageOption {
  code: string;
  name: string;
  english: string;
  aliases: string[];
}
const codes =
  'af am ar az be bg bn bo bs ca cs cy da de el en en-GB en-US es et eu fa fi fil fr fr-CA ga gl gu he hi hr hu hy id is it ja ka kk km kn ko la lo lt lv mk ml mn mr ms mt my nb ne nl nn pa pl ps pt pt-BR pt-PT ro ru si sk sl so sq sr sv sw ta te th tr uk ur uz vi zh-Hans zh-Hant zu'.split(
    ' ',
  );
const english = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' });
const nativeNames: Record<string, string> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  zu: 'isiZulu',
};
const aliases: Record<string, string[]> = {
  'zh-Hans': ['zh', 'zh-CN', 'zh-SG', '中文', '简体'],
  'zh-Hant': ['zh-TW', 'zh-HK', '繁体'],
  en: ['英语', '英文'],
  ja: ['日语', '日文'],
  ko: ['韩语', '韩文'],
};
const collator = new Intl.Collator('en', { sensitivity: 'base' });
export const LANGUAGES: LanguageOption[] = codes
  .map((code) => ({
    code,
    name:
      nativeNames[code] ??
      new Intl.DisplayNames([code], { type: 'language', languageDisplay: 'standard' }).of(code) ??
      code,
    english: english.of(code) ?? code,
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
    return english.of(code) ?? code;
  } catch {
    return code;
  }
}
export function searchLanguages(query: string, allowAuto = false) {
  const key = normalize(query.trim());
  const exact = key
    ? LANGUAGES.filter((language) =>
        [language.code, ...language.aliases].some((value) => normalize(value) === key),
      )
    : [];
  if (exact.length) return exact;
  const options = LANGUAGES.filter((language) =>
    [language.code, language.name, language.english, ...language.aliases].some((value) =>
      normalize(value).includes(key),
    ),
  );
  if (allowAuto && ['auto', '自动识别', 'detect'].some((value) => normalize(value).includes(key)))
    options.unshift({
      code: 'auto',
      name: '自动识别',
      english: 'Automatic detection',
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
      aliases: [],
    });
  return options;
}
export function languageName(value: string) {
  return value === 'auto'
    ? '自动识别'
    : (LANGUAGES.find((language) => language.code === value)?.name ?? value);
}
