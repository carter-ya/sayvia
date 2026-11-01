import { M1_SAMPLES, type EvaluationSample } from './samples';
import type { DomSource } from '../core/source-input';
function dom(text: string, code?: string): DomSource {
  const start = code ? text.indexOf(code) : -1;
  let offset = 0;
  return {
    kind: 'dom-selection',
    text,
    protectedRanges: code ? [{ kind: 'inline-code', start, end: start + code.length }] : [],
    marks: text.split('\n\n').map((paragraph) => {
      const span = { kind: 'paragraph' as const, start: offset, end: offset + paragraph.length };
      offset += paragraph.length + 2;
      return span;
    }),
  };
}
// Written before model execution. Every source and reference is self-authored and public.
const ADDITIONAL: readonly EvaluationSample[] = [
  {
    id: 'release-13',
    title: '版本比较与非承诺语气',
    targetLanguage: 'en',
    source: {
      kind: 'plain-text',
      text: '这个改动只支持 2.4 及以上版本。我们可能在下周修复旧版本，但目前不能承诺日期。',
    },
    protectedText: [],
    referenceMeaning:
      'The change supports version 2.4 and later only. A fix for older versions may arrive next week, with no promised date.',
    reviewFocus: '保留版本下限、可能性和不承诺日期，不能说旧版已经修复。',
  },
  {
    id: 'release-14',
    title: '有条件的复现与排除',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'plain-text',
      text: 'I can reproduce this only when the tab is restored after a crash; opening a fresh tab does not trigger it.',
    },
    protectedText: [],
    referenceMeaning: '只有崩溃后恢复标签页才能复现，新开标签页不会触发。',
    reviewFocus: 'only 和 does not 两个限定不能遗漏，不能混同刷新与恢复。',
  },
  {
    id: 'release-15',
    title: '礼貌请求与信息不确定性',
    targetLanguage: 'en',
    source: {
      kind: 'plain-text',
      text: '感谢补充信息。方便提供一份最小复现吗？如果涉及私有数据，请不要直接贴在公开评论里。',
    },
    protectedText: [],
    referenceMeaning:
      'Thank the author, politely ask for a minimal reproduction, and ask them not to post private data publicly.',
    reviewFocus: '保持礼貌与问句，保留保护私有数据的要求，不添加已确认问题的结论。',
  },
  {
    id: 'release-16',
    title: '性能量级与对照基准',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'plain-text',
      text: 'The median fell from 240 ms to 180 ms, but the slowest 5% still take more than 2 seconds. We have not measured mobile devices.',
    },
    protectedText: [],
    referenceMeaning: '中位数从 240 毫秒降到 180 毫秒，最慢 5% 仍超过 2 秒；尚未测移动设备。',
    reviewFocus: '不能倒置改善方向或把慢尾误写为最快，数字与尚未测量范围保留。',
  },
  {
    id: 'release-17',
    title: '混合语言产品反馈',
    targetLanguage: 'en',
    source: {
      kind: 'plain-text',
      text: '这个 onboarding 很顺，但返回上一步后，之前输入的内容消失了。我希望只撤销当前步骤，不要重置整个流程。',
    },
    protectedText: [],
    referenceMeaning:
      'Onboarding is smooth, but earlier input disappears when going back. Undo the current step without resetting the entire flow.',
    reviewFocus: '中英混合应自然表达，区分返回、撤销和重置，不能淡化丢输入的问题。',
  },
  {
    id: 'release-18',
    title: '澄清引用观点而非本人承诺',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'plain-text',
      text: 'When I said the release was ready, I meant the package could be built, not that the security review had passed.',
    },
    protectedText: [],
    referenceMeaning: '所说的发布准备好只指包可以构建，并不表示安全审核已通过。',
    reviewFocus: '保留本人澄清和两个不同的完成标准，不把审核待办译成通过。',
  },
  {
    id: 'release-19',
    title: '任务列表与代码参数',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '- [x] 增加 `AbortController`\n- [ ] 验证取消后不会重试\n\n请保留 `maxRetries = 0`。',
    },
    protectedText: ['- [x]', '- [ ]', '`AbortController`', '`maxRetries = 0`'],
    referenceMeaning:
      'AbortController is added, cancellation/no-retry verification remains unchecked, and maxRetries must stay zero.',
    reviewFocus: '勾选状态、代码逐字保留，不能把未完成验证说成完成。',
  },
  {
    id: 'release-20',
    title: '引用块与带查询的链接',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'markdown',
      text: '> This is a workaround, not a permanent fix.\n\nSee the [migration guide](https://example.test/migrate?from=2&to=3) before upgrading.',
    },
    protectedText: ['(https://example.test/migrate?from=2&to=3)'],
    referenceMeaning: '这是临时绕过方案，不是永久修复；升级前阅读迁移指南。',
    reviewFocus: '引用结构与链接目标保留，标签可翻译；临时与永久不能颠倒。',
  },
  {
    id: 'release-21',
    title: '编号列表与用户提及',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '1. 先通知 @example-maintainer。\n2. 再运行 `pnpm check`。\n3. 失败时不要合并，详见 https://example.test/checks 。',
    },
    protectedText: ['@example-maintainer', '`pnpm check`', 'https://example.test/checks'],
    referenceMeaning:
      'Notify the maintainer first, run the checks second, and do not merge on failure.',
    reviewFocus: '保留顺序、提及、命令和 URL；不能添加自动合并意图。',
  },
  {
    id: 'release-22',
    title: '代码块的可见解释',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'markdown',
      text: 'The flag must remain disabled by default:\n\n```ts\nconst quickReplace = false;\n```\n\nUsers may enable it after reviewing the behavior.',
    },
    protectedText: ['```ts\nconst quickReplace = false;\n```'],
    referenceMeaning: '该标志默认必须关闭，用户了解行为后可以开启。',
    reviewFocus: '代码块不变，默认关闭与用户主动开启的区别保持。',
  },
  {
    id: 'release-23',
    title: '强调与链接标签',
    targetLanguage: 'en',
    source: {
      kind: 'markdown',
      text: '**请勿**清除生产数据。可以在[本地测试页](https://example.test/local)验证 `storage.session`，但不要复制真实 Key。',
    },
    protectedText: ['(https://example.test/local)', '`storage.session`'],
    referenceMeaning:
      'Do not clear production data. Test storage.session on the local page and never copy real keys.',
    reviewFocus: '保留强调、否定和环境边界，链接标签可翻译。',
  },
  {
    id: 'release-24',
    title: '多段 Markdown 与误解修正',
    targetLanguage: 'zh-CN',
    source: {
      kind: 'markdown',
      text: 'Thanks for checking `documentId`.\n\nThe new request should fail if the document changed, even when the URL is identical. Please keep the original draft available for copying.',
    },
    protectedText: ['`documentId`'],
    referenceMeaning:
      '感谢检查 documentId；文档变了即使 URL 相同也应拒绝新请求，并保留原稿供复制。',
    reviewFocus: '多段语气连贯，区分同 URL 与同文档，保留原稿而非已覆盖结果。',
  },
  {
    id: 'release-25',
    title: '渲染正文中的代码与否定',
    targetLanguage: 'en',
    source: dom(
      '如果 signal.aborted 已经为真，就不要再启动第二个请求。现有结果仍可复制。',
      'signal.aborted',
    ),
    protectedText: ['signal.aborted'],
    referenceMeaning:
      'If signal.aborted is already true, do not start a second request; existing results remain copyable.',
    reviewFocus: '代码身份不丢失，否定与已有结果的可复制性同时保留。',
  },
  {
    id: 'release-26',
    title: '渲染正文的两段条件',
    targetLanguage: 'zh-CN',
    source: dom(
      'The preview is available before replacement.\n\nIf the original changes, the replace button must remain disabled.',
    ),
    protectedText: [],
    referenceMeaning: '替换前可预览；原稿变更后替换按钮必须保持禁用。',
    reviewFocus: '两段结构与先后条件保留，不把禁用译成启用。',
  },
  {
    id: 'release-27',
    title: 'DOM 代码与网络边界',
    targetLanguage: 'en',
    source: dom('不要把 apiKey 发送给页面脚本。模型请求只应由受控扩展上下文发出。', 'apiKey'),
    protectedText: ['apiKey'],
    referenceMeaning:
      'Do not send apiKey to page scripts; model requests must originate in controlled extension contexts.',
    reviewFocus: '技术边界与否定保持，代码不翻译，不能添加平台转发服务器。',
  },
  {
    id: 'release-28',
    title: '渲染正文的写作风格',
    targetLanguage: 'zh-CN',
    source: dom(
      'Could you share which browser version you tested? I may be missing a step, so I would rather confirm the setup before changing the implementation.',
    ),
    protectedText: [],
    referenceMeaning: '礼貌询问测试浏览器版本，说明可能遗漏步骤，先确认环境再改实现。',
    reviewFocus: '保持谦和与不确定语气，不能改成指责或已经确认缺陷。',
  },
  {
    id: 'release-29',
    title: '中文 DOM 中的专有标识',
    targetLanguage: 'en',
    source: dom(
      '请先比较 expectedRevision，再保存新草稿。版本不符时保留当前文字，并提示用户重新载入。',
      'expectedRevision',
    ),
    protectedText: ['expectedRevision'],
    referenceMeaning:
      'Compare expectedRevision before saving; on mismatch keep the current text and ask the user to reload.',
    reviewFocus: '先比较后保存、冲突不丢草稿两项都必须保留，代码原样。',
  },
  {
    id: 'release-30',
    title: '英文 DOM 中的重试策略',
    targetLanguage: 'zh-CN',
    source: dom(
      'A timeout does not prove that the server rejected the request. Do not retry automatically; let the user decide whether to submit again.',
    ),
    protectedText: [],
    referenceMeaning: '超时不能证明服务器拒绝请求；不要自动重试，由用户决定是否再提交。',
    reviewFocus: '因果与不确定性不能颠倒，不得添加自动重试。',
  },
];
export const RELEASE_SAMPLES: readonly EvaluationSample[] = [...M1_SAMPLES, ...ADDITIONAL];
