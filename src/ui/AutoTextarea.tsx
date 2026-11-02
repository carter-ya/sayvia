import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const fit = () => {
      element.style.height = '0px';
      element.style.height = `${Math.max(76, element.scrollHeight)}px`;
    };
    fit();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        fit();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea {...props} ref={field} />;
}
