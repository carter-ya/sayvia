const LANGUAGES = [
  ['zh-Hans', '简体中文'],
  ['zh-Hant', '繁體中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['pt', 'Português'],
] as const;
export function LanguageField({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const known = LANGUAGES.some(([code]) => code === value);
  return (
    <div className="language-field">
      <label>
        {label}
        <select
          aria-label={label}
          value={known ? value : 'custom'}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === 'custom' ? '' : event.target.value)}
        >
          {LANGUAGES.map(([code, name]) => (
            <option value={code} key={code}>
              {name}
            </option>
          ))}
          <option value="custom">其他语言…</option>
        </select>
      </label>
      {!known && (
        <label>
          自定义{label}
          <input
            aria-label={`自定义${label}`}
            value={value}
            maxLength={20}
            required
            disabled={disabled}
            placeholder="例如：Italian 或 it"
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}
