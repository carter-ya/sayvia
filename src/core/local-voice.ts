export interface LocalVoice {
  voiceName?: string;
  lang?: string;
  remote?: boolean;
  extensionId?: string;
}
const canonical = (value: string | undefined) => {
  try {
    return value ? Intl.getCanonicalLocales(value)[0] : undefined;
  } catch {
    return undefined;
  }
};
function family(tag: string) {
  const locale = new Intl.Locale(tag);
  if (locale.language === 'yue') return 'yue';
  if (locale.language === 'cmn') return 'cmn';
  if (locale.language === 'zh') return ['HK', 'MO'].includes(locale.region ?? '') ? 'yue' : 'cmn';
  return locale.language;
}
// A name shared with an unknown/remote engine cannot be safely pinned by Chrome's options.
export function selectLocalVoice(voices: readonly LocalVoice[], language: string) {
  const requested = canonical(language);
  if (!requested) return;
  const candidates = voices.filter((voice) => {
    const tag = canonical(voice.lang);
    return (
      voice.remote === false &&
      !voice.extensionId &&
      !!voice.voiceName &&
      !!tag &&
      family(tag) === family(requested) &&
      voices.filter((other) => other.voiceName === voice.voiceName).length === 1
    );
  });
  const voice =
    candidates.find((candidate) => canonical(candidate.lang) === requested) ?? candidates[0];
  return voice ? { voiceName: voice.voiceName!, lang: canonical(voice.lang)! } : undefined;
}
