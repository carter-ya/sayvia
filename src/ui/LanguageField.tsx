import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { languageName, searchLanguages } from './languages';
export { languageName } from './languages';

const style = `
.language-field { position: relative; min-width: 0; }
.language-field .language-control { position: relative; margin-top: 3px; }
.language-field .language-input { width: 100%; margin-top: 0; padding: 6px 24px 6px 8px; border: 1px solid light-dark(#c8d4cc,#667d6d); border-radius: 6px; color: var(--ink,light-dark(#273b32,#e6eee8)); background: var(--field,light-dark(#f5f7f4,#26362c)); font: inherit; font-size: 13px; line-height: 1.5; }
.language-field .language-control[data-disabled="true"] { cursor: not-allowed; opacity: .55; }
.language-field .language-input:disabled { cursor: not-allowed; }
.language-field .language-input:focus { outline: 2px solid #83b59a; outline-offset: 1px; }
.language-field .language-chevron { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); width: 12px; height: 12px; display: grid; place-items: center; pointer-events: none; color: var(--muted,#768178); }
.language-field .language-list { position: fixed; inset: auto; margin: 0; padding: 4px; border: 1px solid light-dark(#c8d4cc,#667d6d); border-radius: 8px; color: light-dark(#273b32,#e6eee8); background: light-dark(#fff,#1d2822); box-shadow: 0 6px 24px #142b2530; overflow: auto; overscroll-behavior: contain; font: 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
.language-list [role='option'] { padding: 7px 9px; cursor: pointer; border-radius: 5px; }
.language-list [data-active='true'] { background: light-dark(#e8f2ec,#344f3e); }
.language-list [aria-selected='true'] { font-weight: 600; }
.language-list small { display: block; color: light-dark(#62756a,#b0c2b7); font-size: 10px; margin-top: 2px; }
.language-list .language-empty { padding: 10px; color: #768178; }
`;
export function LanguageField({
  label,
  value,
  onChange,
  disabled = false,
  allowAuto = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  allowAuto?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [active, setActive] = useState(0);
  const options = searchLanguages(query, allowAuto);
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const choose = (index: number) => {
    if (disabled) return;
    const option = options[index];
    if (option) {
      onChange(option.code);
      close();
    }
  };
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useLayoutEffect(() => {
    const element = list.current,
      field = input.current;
    if (!element || !field) return;
    if (!open) {
      if (element.matches(':popover-open')) element.hidePopover();
      return;
    }
    element.showPopover();
    const position = () => {
      const rect = field.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 8,
        above = rect.top - 8;
      const down = below >= Math.min(240, above);
      const height = Math.max(32, Math.min(260, down ? below : above));
      element.style.width = `${width}px`;
      element.style.maxHeight = `${height}px`;
      element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
      element.style.top = down ? `${rect.bottom + 4}px` : 'auto';
      element.style.bottom = down ? 'auto' : `${window.innerHeight - rect.top + 4}px`;
    };
    const outside = (event: Event) => {
      const path = event.composedPath();
      if (!path.includes(root.current!) && !path.includes(element)) close();
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', outside, true);
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [open]);
  useLayoutEffect(() => {
    if (open)
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, query]);
  return (
    <div className="language-field" ref={root}>
      <label htmlFor={id}>{label}</label>
      <style>{style}</style>
      <div
        className="language-control"
        data-disabled={disabled}
        title={disabled ? '暂不可切换语言' : undefined}
      >
        <input
          id={id}
          ref={input}
          className="language-input"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={open && options[active] ? `${id}-${active}` : undefined}
          autoComplete="off"
          value={open ? query : languageName(value)}
          disabled={disabled}
          placeholder="搜索语言或 BCP-47"
          onFocus={() => {
            setQuery('');
            setActive(0);
            setOpen(true);
          }}
          onClick={() => {
            if (!open) {
              setQuery('');
              setActive(0);
              setOpen(true);
            }
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onBlur={close}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape' && open) {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!open) {
                setQuery('');
                setOpen(true);
              }
              setActive((previous) =>
                Math.max(
                  0,
                  Math.min(options.length - 1, previous + (event.key === 'ArrowDown' ? 1 : -1)),
                ),
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (open) choose(active);
              else setOpen(true);
            }
          }}
        />
        <span className="language-chevron" aria-hidden="true">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </span>
      </div>
      <div
        id={`${id}-list`}
        ref={list}
        className="language-list"
        role="listbox"
        tabIndex={-1}
        aria-label={`${label}选项`}
        popover="manual"
      >
        {options.length ? (
          options.map((option, index) => (
            <div
              key={option.code}
              id={`${id}-${index}`}
              role="option"
              data-language-code={option.code}
              data-active={index === active}
              aria-selected={option.code === value}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {option.name}
              <small>
                {option.english}
                {option.native &&
                option.native !== option.english &&
                option.native !== option.name ? (
                  <>
                    {' '}
                    · <bdi>{option.native}</bdi>
                  </>
                ) : null}{' '}
                · {option.code}
              </small>
            </div>
          ))
        ) : (
          <div className="language-empty">未找到语言，可输入 BCP-47 标签</div>
        )}
      </div>
    </div>
  );
}
