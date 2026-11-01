import { useEffect, useState } from 'react';
import type { ConfigSnapshot } from '../storage/schema';
import { LanguageField } from './LanguageField';
export function PreferencesForm({
  snapshot,
  busy,
  onSave,
  onDirty,
}: {
  snapshot: ConfigSnapshot;
  busy: boolean;
  onDirty(): void;
  onSave(preferences: ConfigSnapshot['preferences']): void;
}) {
  const [preferences, setPreferences] = useState(snapshot.preferences);
  useEffect(() => {
    const root = document.documentElement;
    const scheme = (theme: typeof preferences.theme) => (theme === 'system' ? 'light dark' : theme);
    root.style.colorScheme = scheme(preferences.theme);
    return () => {
      root.style.colorScheme = scheme(snapshot.preferences.theme);
    };
  }, [preferences.theme, snapshot.preferences.theme]);
  const change = (next: Partial<ConfigSnapshot['preferences']>) => {
    setPreferences({ ...preferences, ...next });
    onDirty();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(preferences);
      }}
    >
      <fieldset className="provider-fields" disabled={busy}>
        <label>
          默认模型
          <select
            value={preferences.defaultProviderId ?? ''}
            onChange={(event) => change({ defaultProviderId: event.target.value || undefined })}
          >
            <option value="">暂不选择</option>
            {snapshot.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {provider.model}
              </option>
            ))}
          </select>
        </label>
        <p className="field-help">切换默认模型只影响新任务，进行中的翻译保持原模型。</p>
        <div className="field-pair">
          <LanguageField
            label="阅读目标语言"
            value={preferences.readTarget}
            onChange={(readTarget) => change({ readTarget })}
          />
          <LanguageField
            label="写作目标语言"
            value={preferences.writeTarget}
            onChange={(writeTarget) => change({ writeTarget })}
          />
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={preferences.quickReplace}
            onChange={(event) => {
              if (event.nativeEvent.isTrusted) change({ quickReplace: event.target.checked });
            }}
          />
          开启写作快速替换
        </label>
        <p className="field-help">
          翻译成功且原稿未改动时自动替换，可一步恢复；原稿变化、后台恢复或格式校验失败时只提供预览与复制。
        </p>
        <label>
          界面主题
          <select
            value={preferences.theme}
            onChange={(event) =>
              change({
                theme: event.target.value as typeof preferences.theme,
              })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <div className="form-footer">
          <button
            disabled={busy || !preferences.readTarget.trim() || !preferences.writeTarget.trim()}
          >
            保存偏好
          </button>
        </div>
      </fieldset>
    </form>
  );
}
