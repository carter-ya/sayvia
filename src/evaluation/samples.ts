import type { DomSource, SourceInput } from '../core/source-input';

export interface EvaluationSample {
  id: string;
  title: string;
  source: SourceInput;
  targetLanguage: 'en' | 'zh-CN';
  protectedText: string[];
  referenceMeaning: string;
  reviewFocus: string;
}

function domCode(text: string, code: string, kind: 'inline-code' | 'code-block'): DomSource {
  const start = text.indexOf(code);
  return {
    kind: 'dom-selection',
    text,
    protectedRanges: [{ kind, start, end: start + code.length }],
    marks: [],
  };
}

// Self-authored, public test data. These are review references, not model outputs.
export const M1_SAMPLES: readonly EvaluationSample[] = [
  {
    id: 'm1-01',
    title: '否定、条件和数字',
    targetLanguage: 'en',
    source: {
      kind: 'plain-text',
      text: '只有测试通过后才可以合并。这不是已经修复的确认；请保留 3 次重试，不要改成 5 次。',
    },
    protectedText: [],
    referenceMeaning:
      'Merge only after tests pass. This does not confirm a fix. Keep 3 retries, not 5.',
    reviewFocus: '条件、否定和两个数字不能反转；不得添加已经修复的承诺。',
  },
  {
    id: 'm1-02',
    title: '普通英文技术词',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'plain-text',
      text: 'The timeout may increase under load, but we have not confirmed the cause.',
    },
    protectedText: [],
    referenceMeaning: '高负载时超时时间可能增加，但原因尚未确认。',
    reviewFocus: '普通正文 timeout 应翻译；保留 may 和尚未确认的语气。',
  },
  {
    id: 'm1-03',
    title: 'Markdown 行内代码与链接',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '请保持 `timeout` 不变，并阅读[配置指南](https://example.test/config?mode=basic)。',
    },
    protectedText: ['`timeout`', '(https://example.test/config?mode=basic)'],
    referenceMeaning: 'Keep timeout unchanged and read the configuration guide.',
    reviewFocus: '代码和 URL 原样保留，链接标签可以翻译。',
  },
  {
    id: 'm1-04',
    title: 'Markdown 围栏代码',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '先运行以下示例，暂时不要增加重试次数。\n\n```ts\nconst retries = 3;\n  run(retries);\n```\n\n如果失败，请报告错误。',
    },
    protectedText: ['```ts\nconst retries = 3;\n  run(retries);\n```'],
    referenceMeaning:
      'Run the example first; do not increase retries yet. Report errors if it fails.',
    reviewFocus: '围栏、缩进、空行保留；条件与否定不丢失。',
  },
  {
    id: 'm1-05',
    title: '列表与任务状态',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '- [x] 已确认问题\n- [ ] 尚未修复\n\n1. 备份配置\n2. 再执行测试',
    },
    protectedText: ['- [x] ', '- [ ] ', '\n\n1. ', '\n2. '],
    referenceMeaning: 'Issue confirmed, fix pending. Back up configuration, then test.',
    reviewFocus: '不能改变勾选状态、列表编号和顺序。',
  },
  {
    id: 'm1-06',
    title: '图片说明和引用链接',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '![设置界面](https://example.test/settings.png "settings")\n\n查看[安装说明][install]。\n\n[install]: https://example.test/install "installation"',
    },
    protectedText: [
      '(https://example.test/settings.png "settings")',
      '[install]',
      '[install]: https://example.test/install "installation"',
    ],
    referenceMeaning: 'Settings screen. See the installation instructions.',
    reviewFocus: '图片替代文字及完整引用链接标签可译，目的地和标识不变。',
  },
  {
    id: 'm1-07',
    title: '引用、强调、转义与 HTML',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '> 这**不是**发布承诺。\n\n请保留 \\* 字符和 &amp; 实体。<b>KEEP_HTML</b>',
    },
    protectedText: ['> ', '**', '\\*', '&amp;', '<b>KEEP_HTML</b>'],
    referenceMeaning: 'This is not a release promise. Keep the literal star and entity.',
    reviewFocus: '否定、引用结构、强调和 HTML 原样保护。',
  },
  {
    id: 'm1-08',
    title: 'GFM 表格',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '| 项目 | 状态 |\n| :--- | ---: |\n| 翻译 | 待审核 |\n| 发布 | 未承诺 |',
    },
    protectedText: ['| :--- | ---: |'],
    referenceMeaning: 'Translation: pending review. Release: no commitment.',
    reviewFocus: '列数、对齐、行序不变；状态不扩大为已完成。',
  },
  {
    id: 'm1-09',
    title: '纯文本 URL、提及与 Issue 引用',
    targetLanguage: 'en',
    source: {
      kind: 'plain-text',
      text: '请 @carter-ya 查看 owner/repo#123 和 #42。\n参考 https://example.test/guide?a=1，不要发送邮件到 demo@example.test',
    },
    protectedText: [
      '@carter-ya',
      'owner/repo#123',
      '#42',
      '\n',
      'https://example.test/guide?a=1',
      'demo@example.test',
    ],
    referenceMeaning:
      'Ask the mentioned user to review both issues. See the guide; do not email the given address.',
    reviewFocus: '保留提及、引用、地址和换行，禁止把否定变成发送邮件。',
  },
  {
    id: 'm1-10',
    title: '渲染后的局部代码',
    targetLanguage: 'zh-CN',
    source: domCode('Read timeout only if the request fails.', 'timeout', 'inline-code'),
    protectedText: ['timeout'],
    referenceMeaning: '只有请求失败时才读取 timeout。',
    reviewFocus: '没有反引号的 DOM 代码保持不变；if 条件不可丢失。',
  },
  {
    id: 'm1-11',
    title: 'DOM 代码块与段落',
    targetLanguage: 'zh-CN',
    source: domCode(
      'Run the example:\nconst limit = 3;\n  retry(limit);\nDo not increase it.',
      'const limit = 3;\n  retry(limit);',
      'code-block',
    ),
    protectedText: ['const limit = 3;\n  retry(limit);'],
    referenceMeaning: '运行示例，不要提高该限制。',
    reviewFocus: '代码空白、数字和换行原样保留；正文否定保持。',
  },
  {
    id: 'm1-12',
    title: 'DOM 链接标签与非自动保存',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'dom-selection',
      text: 'Read the setup guide.\nChanges are not saved automatically.',
      protectedRanges: [],
      marks: [
        { kind: 'link-label', start: 9, end: 20 },
        { kind: 'line-break', start: 21, end: 22 },
      ],
    },
    protectedText: ['\n'],
    referenceMeaning: '阅读设置指南。更改不会自动保存。',
    reviewFocus: '可见链接标签自然翻译，不采集隐藏 href；否定和换行保持。',
  },
];
