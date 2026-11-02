import { createElement, useMemo, type ReactNode, type MouseEvent } from 'react';
import type { Root, RootContent } from 'mdast';
import { parseMarkdown } from '../core/markdown';
import { safeWebLink } from '../core/safe-link';

type TreeNode = Root | RootContent;
export function ReadingPreview({ text }: { text: string }) {
  const content = useMemo(() => {
    try {
      const tree = parseMarkdown(text);
      const definitions = new Map(
        tree.children
          .filter((node) => node.type === 'definition')
          .map((node) => [node.identifier, node.url]),
      );
      let visited = 0;
      const render = (node: TreeNode, index: number, depth = 0): ReactNode => {
        if (++visited > 4096 || depth > 128) throw Error('PREVIEW_TOO_COMPLEX');
        const children =
          'children' in node
            ? node.children.map((child, i) => render(child, i, depth + 1))
            : undefined;
        const link = (url: string | undefined) => {
          const href = url && safeWebLink(url);
          const open = (event: MouseEvent<HTMLAnchorElement>) => {
            if (event.button !== 0 && event.button !== 1) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.nativeEvent.isTrusted && href)
              window.open(href, '_blank', 'noopener,noreferrer');
          };
          return href ? (
            <a
              key={index}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={open}
              onAuxClick={open}
            >
              {children}
            </a>
          ) : (
            <span key={index}>{children}</span>
          );
        };
        switch (node.type) {
          case 'root':
            return children;
          case 'text':
            return node.value;
          case 'paragraph':
            return <p key={index}>{children}</p>;
          case 'inlineCode':
            return <code key={index}>{node.value}</code>;
          case 'code':
            return (
              <pre key={index}>
                <code>{node.value}</code>
              </pre>
            );
          case 'link':
            return link(node.url);
          case 'linkReference':
            return link(definitions.get(node.identifier));
          case 'strong':
            return <strong key={index}>{children}</strong>;
          case 'emphasis':
            return <em key={index}>{children}</em>;
          case 'delete':
            return <del key={index}>{children}</del>;
          case 'break':
            return <br key={index} />;
          case 'heading':
            return createElement(`h${node.depth}`, { key: index }, children);
          case 'blockquote':
            return <blockquote key={index}>{children}</blockquote>;
          case 'list':
            return node.ordered ? (
              <ol key={index} start={node.start ?? 1}>
                {children}
              </ol>
            ) : (
              <ul key={index}>{children}</ul>
            );
          case 'listItem':
            return (
              <li key={index}>
                {node.checked === null || node.checked === undefined ? null : (
                  <input
                    type="checkbox"
                    checked={node.checked}
                    disabled
                    aria-label={node.checked ? '已完成' : '未完成'}
                  />
                )}{' '}
                {children}
              </li>
            );
          case 'table':
            return (
              <div key={index} className="preview-table">
                <table>
                  <tbody>{children}</tbody>
                </table>
              </div>
            );
          case 'tableRow':
            return <tr key={index}>{children}</tr>;
          case 'tableCell':
            return <td key={index}>{children}</td>;
          case 'thematicBreak':
            return <hr key={index} />;
          case 'html':
            return node.value;
          case 'image':
          case 'imageReference':
            return node.alt ?? '';
          case 'definition':
            return null;
          default:
            return children;
        }
      };
      return render(tree, 0);
    } catch {
      return <pre>{text}</pre>;
    }
  }, [text]);
  return <div className="reading-preview">{content}</div>;
}
