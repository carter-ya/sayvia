const paths = {
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  swap: 'M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4',
  preview: 'M3 4h18v16H3zM14 4v16',
  grip: 'M8 5h.01M8 12h.01M8 19h.01M16 5h.01M16 12h.01M16 19h.01',
  appearance: 'M16 3a8 8 0 1 0 5 13M3 8a8 8 0 1 0 13-5',
  close: 'm6 6 12 12M6 18 18 6',
  copy: 'M9 9h11v11H9zM15 5V3H3v12h2',
  edit: 'm15 4 5 5M4 16l-1 5 5-1L21 7a2 2 0 0 0-4-4Z',
  refresh: 'M20 7V3l-3 3a8 8 0 1 0 3 9M20 3h-5',
  collapse: 'M5 12h14',
  expand: 'M5 12h14M12 5v14',
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
