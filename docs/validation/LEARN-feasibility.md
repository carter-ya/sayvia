# LEARN：AI 查词与系统朗读可行性研究

> 历史研究记录：当前决策和后续真实验证见 [实现契约](../LEARN_IMPLEMENTATION.md) 及 [审核记录](LEARN-review-log.md)。保留本轮失败结果，不把旧候选状态当作当前结论。

- 日期：2026-11-03
- 对应需求：PRD v0.10 第 17 节；技术方案 v0.7 第 16 节
- 查阅代码基线：`5d69f9c` 加当时工作区；工作区已有其他阅读功能改动，本次未修改生产代码。
- 状态：需求调整、代码接入分析与独立 TTS 探针完成；未实现查词产品流程，未完成真实模型质量和实际音质验收。

## 1 结论

简化后的方案具备实施基础：复用现有模型配置与 Key，一次生成词性、简短释义和例句；播放通过 Chrome 的本地系统语音，不需要词典数据库、词典 API、音频文件服务或业务后端。首期保留多语言，明确标注“AI 解释”“合成语音”，不承诺权威音标和逐义项准确发音。

有两项真实接入工作不能省略：现有任务只能返回翻译结果，需新增查词任务和校验；后台需新增受限朗读消息、tts 权限与播放所有权管理。这不是只改提示词即可上线，但比完整词典系统少了数据源、许可、音频匹配和额外服务配置。

## 2 代码接入分析

| 现有模块 | 可复用部分 | 必要变化 |
| --- | --- | --- |
| `src/providers/chat-completions.ts` | Base URL、Bearer Key、流式传输、截止、错误及用量解析 | 当前 SYSTEM_INSTRUCTION 和 processor 绑定 segments 翻译；拆出公共请求基础，新增 lookup 提示、完整 JSON 解析和有界结果结构 |
| `src/runtime/task-protocol.ts`、`executor-protocol.ts` | 来源校验、文档身份、配置与执行契约 | 添加与来源模式正交的 purpose；旧请求默认 translate，lookup 只读，不进入写作替换 |
| `src/background/task-broker.ts`、`src/executor/task-runner.ts` | 同标签互斥、取消、迟到结果、配置 revision 和临时结果管理 | 按任务种类分发和恢复，不将查词结果送进翻译重建流程 |
| `src/executor/worker-processor.ts`、`src/background/executor-host.ts` | Worker 通道及按任务创建／释放的 Offscreen | 新增实际 lookup 数据校验分支，保持 WORKERS 用途成立；朗读不使用该执行环境 |
| `src/ui/TranslationPanel.tsx`、`src/content/workflow.tsx` | 面板外观、源语言／目标语言、选区与文档生命周期 | 新增明确查词入口与只读卡片；当前阅读功能有其他未提交改动，实施时基于最新接口接入 |
| `entrypoints/background.ts`、`wxt.config.ts` | 消息注册、标签页关闭／导航事件 | 新增 tts 权限和语音消息路由，检查 speechId／文档／所有者；不允许网页指定任意地址或音频 |

建议 lookup 结果只含语言、最多 3 个词性／释义条目、最多 1 个例句及译文，可附简短歧义说明。普通兼容接口用 messages 请求 JSON 后本地校验，不要求服务支持 JSON Schema 或工具调用；格式失败提示手动重试，不能隐式再付费修复。单次查词可用一个模型请求完成，但新提示的实际成功率仍需验证。

## 3 系统语音选型

采用后台 `chrome.tts`。官方接口提供枚举、语速、停止和播放事件，需要 `tts` 权限；内容脚本需要通过消息间接访问。语音标记 `remote` 可用于排除远程引擎。本期只用设备本地音源，不增加语音 Key。[Chrome TTS](https://developer.chrome.com/docs/extensions/reference/api/tts)、[内容脚本能力](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

Web Speech API 的 `speechSynthesis` 也能枚举系统语音，但需处理异步语音列表以及页面生命周期。本项目已有后台消息机制，集中管理多个标签页播放更合适，因此首期不同时维护两套实现。[语音枚举](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/getVoices)、[语音列表变化事件](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/voiceschanged_event)

## 4 本机探针与结果

使用独立最小 Manifest V3 测试扩展，只申请 tts 权限。Playwright 创建临时浏览器资料，测试后关闭并删除；不加载 Sayvia、不读取个人资料、不使用模型 Key、不发起付费请求。浏览器为本机 Playwright 提供的 Chrome for Testing 156，macOS arm64。所有朗读 volume=0，因此只验证真实 API 事件与参数接纳，不验证实际听感、发音准确性或声速。

可复现入口：[探针](learn-tts-probe.mjs)；完整记录：[结果 JSON](learn-tts-results.json)。

```sh
node docs/validation/learn-tts-probe.mjs --headed > /tmp/sayvia-tts-headed-result.json
node docs/validation/learn-tts-probe.mjs > /tmp/sayvia-tts-headless-result.json
```

首次立即枚举的无界面运行返回 0 个语音。随后探针增加最多 10 次、间隔 300 毫秒的初始化重查，可见与无界面运行均取得 180 个本地语音。两次运行之间的系统预热也可能影响结果；这不足以证明空列表只有一种原因。产品应先显示加载中、进行有界重查，仍缺失时给出不可用提示和重新检测入口。

| 语言 | 本次选中的本地语音 | 可见浏览器常速／慢速 | 无界面浏览器常速／慢速 |
| --- | --- | --- | --- |
| 中文普通话 | 婷婷，zh-CN | end / end | end / end |
| 英语 | Albert，en-US | end / end | end / end |
| 日语 | Eddy，ja-JP | end / end | end / end |
| 韩语 | Eddy，ko-KR | end / end | end / end |
| 法语 | Eddy，fr-FR | end / end | end / end |
| 德语 | Anna，de-DE | end / end | end / end |
| 西班牙语 | Eddy，es-ES | end / end | end / end |

常速 rate=1、慢速 rate=0.75，合计 28 次完整朗读调用均取得 start 与 end。两种浏览器模式各自追加一次开始后停止，均取得 interrupted。探针按语言挑选首个匹配音源，表中名字不是产品默认声线承诺。

部分短词的慢速调用事件时长短于首次常速调用，可能涉及预热、引擎和事件时序；因此本次只证明 rate 参数可传入，不宣称“慢速实际效果已通过”。正式验收需同音源预热后实听正常／慢速，并测量相同音频内容，不能只比较 API 调用耗时。

## 5 实施风险与验收边界

| 项目 | 当前证据 | 实施阶段要求 |
| --- | --- | --- |
| 模型复用 | 已有 Chat Completions 实现和配置链路；代码上可增加 lookup | 本轮未调用真实模型；新提示在各拟支持模型／语言上运行，验证一次请求的格式和释义质量 |
| 本地语音 | 本机七种语言均有音源并完成事件链 | 其他设备／系统不得默认具备相同音源；无语音明确降级，实听和慢速效果仍待验收 |
| 后台入口 | 独立 MV3 后台实际调用成功 | 尚未测试生产 sender 校验、卡片关闭、导航、跨标签竞态及后台回收／重启；不可把探针当作这些已通过 |
| 内容质量 | 功能定位已降低为 AI 解释与合成朗读 | 多音词及无上下文歧义提示；不承诺标准音标／真人／词典权威性 |
| 费用与隐私 | 查词计划复用用户当前模型；语音仅本地 | 请求次数、输入范围及输出校验需在实现测试中确认；不要将远程 voice 误标成本地 |

此次没有接入完整模型查词链路，也没有在用户使用的扩展中加按钮；未运行整个工作区测试，因为本次未改生产代码。独立探针、语法、定向 lint、文档一致性与 diff 检查作为本次验证范围。

## 6 YouTube 保留为独立验证项

此次简化不改变双语字幕需求。字幕仍须先取得可前瞻的时间轴，再按播放位置分批翻译和缓存；仅观察屏幕上的当前字幕不能证明能提前翻译。YouTube 官方下载 API 要求编辑视频权限，不能用来替代普通观看页面的适配验证。[官方接口限制](https://developers.google.com/youtube/data/reference/rest/v3/captions/download)

前瞻 30～60 秒只是候选窗口。连续播放可跟上的必要条件是批次翻译耗时小于该批字幕对应的视频时长除以播放倍速，还需留出网络抖动余量。实测应记录完整可用批次的耗时、冷启动和跳转等待；模型首 token 速度不能代替可显示字幕的完成时间。本报告初轮没有进行 YouTube 实站提取或字幕模型性能测试；用户随后要求单独验证，结果已记录在 [YouTube 可行性研究](YOUTUBE-feasibility.md)：真实播放器字幕可见，独立请求未取得时间轴，真实模型夹具计时完成。L00b 尚未通过，不阻塞独立 AI 查词功能实施。
