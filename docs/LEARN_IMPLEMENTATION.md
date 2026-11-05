# 视频字幕与多语言查词：实现契约

- 日期：2026-11-03；基线：main `742602f`。
- 状态：独立技术最终复审通过，方案无待修 P1/P2；生产实现、各层 PR 审核和产品验收尚未完成。
- 范围：YouTube 桌面常规视频的双语／仅译文字幕；多语言 AI 查词与本地合成朗读。直播、Shorts、嵌入、画中画和无字幕音频识别不属于本期。
- 研究文档描述历史候选；发生差异时，本契约的明确决策优先。各阶段实际结果分别记录，不以方案审查替代运行验收。

## 1 已经取得的关键证据

本次在独立、未登录的 Chrome for Testing 156 中加载自写 MV3 原型，仅通过播放器正常 UI 选择字幕；捕获 XHR 原响应，没有重发 timedtext 请求、读取个人登录资料或调用模型。

| 视频 | 源轨 | 正文字节 | 诊断条目 | 最后结束时间 | 本次响应耗时 |
| --- | --- | --- | --- | --- | --- |
| eIho2S0ZahI | 英语人工 | 31,297 | 229 | 591.933 秒 | 719 ms |
| eIho2S0ZahI | 英语自动 | 186,824 | 284 | 594.129 秒 | 578 ms |
| arj7oStGLkU | 英语人工 | 43,156 | 315 | 842.624 秒 | 391 ms |
| arj7oStGLkU | 英语自动 | 241,331 | 335 | 843.279 秒 | 727 ms |

全部为 JSON3，包含当前播放点之后的时间轴。原文重绘、隐藏／恢复原生外观、全屏和站内导航均实际观察到。统计来自诊断解析器，尚不表示 ASR 规范化或同步精度通过。

真实复现了中途启用缺失：捕获关闭期间播放器加载 ASR；重新开启后没有重放响应，播放器当前轨为 ASR，但缓存仍是旧人工轨。刷新后重新取得字幕，不过 YouTube 将源轨重置成人工轨。因此不能仅按视频 ID 或语言匹配缓存，也不能承诺刷新保留 ASR 选择。

证据：[人工](validation/youtube-prototype-manual-results.json)、[自动](validation/youtube-prototype-asr-results.json)、[站内导航](validation/youtube-prototype-second-results.json)、[刷新](validation/youtube-prototype-reloaded-results.json)、[中途启用缺失](validation/youtube-prototype-late-enable-results.json)、[第二份自动字幕](validation/youtube-prototype-second-asr-results.json)。截图：[人工重绘](validation/youtube-prototype-manual.png)、[恢复](validation/youtube-prototype-restored.png)、[全屏](validation/youtube-prototype-fullscreen.png)。完整字幕仅用于本地临时验证，不提交仓库。

## 2 字幕捕获授权与启用流程

区分两个用户动作：

1. **站点功能开关**：默认关闭。用户开启后允许访问 YouTube 时在当前页面内临时捕获播放器已经加载的字幕；不发送模型。权限仍受 Chrome 网站访问设置限制。
2. **当前视频翻译开关**：仅对当前文档／视频创建翻译会话，分批发送所选源轨给当前模型；站内换视频清除该授权。不会因曾开启一次而自动翻译以后所有视频。

启用入口说明本地缓存和模型发送的区别。关闭站点功能会关闭翻译、停止捕获并清理字幕。字幕不落盘，不形成观看历史。

后台使用串行 reconcile 管理 desiredEnabled 与实际注册状态：先保存期望值，再注册唯一、版本化的 MAIN document_start 脚本，匹配 `https://www.youtube.com/*`、顶层、persistAcrossSessions。仅注册成功后返回 enabled。脚本安装即开始有界本地捕获，**不等待异步启用握手**；注册的存在由已确认的站点授权决定。启动／更新时复核注册版本，失败显示失败而非就绪。

已有页首次启用可补注入以捕获未来请求。若当前轨只在播放器内存中，提供“刷新后读取字幕”；只有注册成功后，用户点击才刷新。刷新后从实际轨状态重新确认身份，不恢复旧 ASR 标签。网站拒绝字幕时停止重试；刷新不是绕过拒绝的保证。

关闭顺序：撤销后台翻译授权并取消任务、推进 generation → 注销专用注册 → 向所有已知活动文档发送停用与清理并复核送达。冻结页面恢复时必须重新检查授权，未确认不得捕获／发送／接管显示。原型默认安装即启用；生产动态注册与撤销需要单独验证。

## 3 获取、轨身份及 ASR 规范化

MAIN 只包装 fetch／XHR 的正常响应，返回原请求结果，不改 URL／签名／headers，不发字幕请求。严格匹配已验证的 `www.youtube.com/api/timedtext`，校验最终响应 URL；fetch 使用及时、有界的 clone 流，取消只影响扩展分支。XHR 按实际 responseType 读取并在复制／解析前限制大小。关闭／导航时取消本地 reader、监听、定时器；还原包装函数时只还原仍等于本包装的属性。

请求发起时冻结 captureGeneration、videoId 和规范化轨键；响应返回后再次匹配，旧响应不能填充新会话。轨键至少包含 videoId、lang、kind、name、tlang，null／空串规范化；format 不属于轨身份。tlang 非空是平台翻译轨，提示用户选择原语言轨，不进行双重翻译。

**源轨选择由 YouTube 原生字幕菜单完成，Sayvia 跟随其实际选轨。** 不通过私有写接口强制切换。实测可读的 `getOption('captions','track')` 返回 languageCode、kind、name，`getVideoData().video_id` 返回当前视频；vssId 实测缺失，不可作为唯一依据。只读快照经 MAIN 数据桥传递，频率最多 4 次／秒、变化时才发送。接口缺失、匹配不唯一、页面视频与播放器视频不一致时暂停接管并恢复原生。此适配层是私有接口维护点，不是稳定公共 API。

广告通过已观察的播放器状态类辅助识别；广告中或身份不确定时不显示正片字幕。实际广告样例和播放器节点复用仍是专项测试门槛，不由两个无广告样例推断通过。

当前真实响应优先实现 JSON3；其他结构明确 UNSUPPORTED_CAPTION_FORMAT，保留原生字幕。XML／WebVTT 通过实际样例验证后扩展解析器，不重发修改格式的请求。

ASR 使用窗口 ID／事件序号／开始时间标识，不按全文去重。真实样例包括窗口配置、带词偏移的完整行事件、仅换行的 aAppend 事件；335 条有文字行对应 670 个原始事件。规范化显示单位是完整字幕行，不做逐词高亮：忽略纯换行追加；上一行结束取 min(原声明结束时间, 同窗口下一完整行开始时间)，保留原有空档。相同起点的完整行以较后事件替换，零时长行不展示也不翻译；倒序、负时长拒绝该轨。

非空追加按同窗口当前行拼接并生成 revision；在追加事件时间切分显示区间，追加前显示旧文字，追加后才显示新 revision，不把未来文字提前展示。每个 revision 的结束均不越过其有效结束时间和下一替换边界；无明确时长时只继承父行剩余时长，不推测延长。缺少有效父行、追加发生在父行结束之后或无法解释的修订拒绝该轨。翻译按各 revision 的完整文字及有效区间缓存，不能把追加片段单独翻译。保留源事件至显示行映射，以真实录制回放校验时间边界。

ASR 翻译／展示采用本地有界分组，人工字幕保持原行。先在整份规范化时间轴上确定分组，再按组预取，不随当前播放点／批次变化重分组。同窗口按时间贪心合并连续源行，仅当上一有效区间 end 等于下一 start 才合组；最多 3 行、8 秒跨度、200 Unicode 码点，遇句末标点提前结束，加入下一行会超限时先提交当前组。单行本身超过 8 秒或 200 码点时原样独立成组，仍受原 cue 硬上限约束，不截断。标点仅是启发式，不保证组等于完整句。

任何组不得跨追加 revision 的生效边界；带追加修订的行各 revision 独立成组，不与邻行合并，防止未来修订提前展示。源修订改变时重建受影响组并失效旧请求／缓存。groupId 从轨键、分组算法版本、有序 sourceCueIds/revisions、显示区间生成，保留内容 revision 与完整源行映射；模型不能决定分组。合并普通源行的整组原文及译文在 first.start 至 last.end 一起展示，组内后续源行词语可能在组起点出现，这是明确的整组模式，不是逐词同步。译文不再机械切回原行，原文可按行换行。≤250 ms 同步目标衡量本地组边界；语义验收检查组内及相邻组事实完整、不重复，连续观看另测。

预算固定为：单响应解码 4 MiB，当前视频原文与译文 UTF-8 合计 8 MiB，最多 20,000 条规范 cue，每条最多 4,000 Unicode 码点；先达到任一限额停止新增并提示，不把截断数据声明为全量。只转发已校验字段，不传签名 URL 或令牌。

数据桥只接收有界 JSON 字符串，UTF-8 单消息（含信封）≤64 KiB，每块≤100 cue、每响应≤256 块且≤4 MiB。一个文档最多同时重组两个响应，未完成数据合计≤8 MiB，首块起 10 秒超时；接受前先检查字符长度，之后验证字节／schema。接收端令牌桶每秒 64 消息、突发 64；发送端以相同速率节流。每响应独立随机 responseId，与 captureGeneration、规范轨键共同绑定，不能用轨键替代响应身份。必须从序号 0 按序连续接收，重复、乱序、总块数变化、冲突或任何超限都丢弃该整个响应并暂停接管；禁止把两个请求拼接。超时／取消／导航清空重组和相关计数，完成时一次性提交缓存，绝不使用不完整响应。

## 4 统一执行器的新增契约

保留旧 translation.start、普通翻译 source 和结果的兼容行为；新增 purpose，旧数据缺省 translate。网络传输、错误映射、用量、截止、Key 防泄漏和取消提取为共用基础；提示和 Worker 处理器按目的分支。

| purpose | 允许入口／来源 | 输入 | 完整结果 |
| --- | --- | --- | --- |
| translate | 原 read／write／manual 不变 | 原 SourceInput | 原 TranslationResult |
| lookup | 页面选词或可信手动弹窗；字幕选词也走只读页面查词 | text、sourceLanguage、explanationLanguage | LookupResult + 通用 metrics |
| captions | 当前 YouTube 文档，后台已授权的视频会话 | sessionId、generation、videoId、trackKey、batchId、本地显示单元列表（人工行／ASR组） | 同身份字段、每个 unitId/revision 对应译文 + metrics |

新的 learning.start 消息用 purpose 判别联合，lookup 的 origin 为 page/manual，captions 只能为 page；所有分支都有 clientTaskId、documentNonce，页面真实 tab/document 从 sender 取得。调用方提供的标识不能取代后台身份校验。字幕不得伪装成 dom-selection 或 manual，lookup/captions 不产生 canApply，不进入写作替换或阅读原位回写。

Route、Execution、ExecutionView、delivery/result 联合及 session 恢复同步扩展 purpose。旧记录按 translate 解码。lookup 手动草稿增加独立 purpose 和结构化结果字段；切换目的递增草稿 revision，旧翻译字符串不被解释成词典卡片。字幕结果只在当前文档会话内恢复；后台重启后不自行恢复连续预取，要求重新确认页面会话。

Worker 实际承担 lookup 输入／完整结果 schema 校验、caption ID／文本版本校验；不保留 WORKERS 声明却绕过 Worker。lookup 与 caption 不展示未完成的结构化数据；进度只显示状态和用量。

caption batch：1～20 显示单元、输入累计 ≤6,000 Unicode 码点，unitId（人工 cueId 或 ASR groupId）≤160 字符、revision 为非负整数、videoId ≤64 字符、trackKey ≤256 字符。模型只得到语言、ID、原文；时间戳与网页身份留在本地。响应必须每 ID 恰好一次，不能缺失、重复、未知或错版本；总译文 ≤48,000 字符。模型不决定开始／结束时间。人工行／ASR组均不承诺目标语言词序与源语逐词同步；组内允许自然语序调整，紧邻单元间必要语序调整须单独审查，禁止重复或丢失事实，不在更远单元间搬移内容。自动字幕可能有识别噪声，提示只去除明显口吃重复而不擅自补写事实；语义回归单独检查，ID 校验不能证明逐行语义正确。

## 5 调度、显示和异常恢复

同 tab 保持单模型任务。显式阅读／写作／查词到来时，在 broker 串行区内先取消正在运行的字幕批次并使旧结果失效，再启动显式任务；不等待字幕批次 60 秒结束，不返回无解释的 TASK_BUSY。显式任务结束且视频会话仍有效时，字幕控制器可恢复有限预取；被中断批次只在仍属当前需求窗口时重新排入，记录这是用户操作导致的重算，不做错误自动重试。

取消确认丢失时不启动新的付费请求。字幕记录以 canceled／cancelPending 保留 tab 与全局槽位，禁止再交付旧结果；后台重启和清除配置也保留这份无正文占位。重连并确认终态，或浏览器确认旧执行器已不存在／epoch 已替换后释放；暂时失联不会只凭时间推测请求已停止。这种故障会暂时阻止同 tab 新任务，明确优先避免重复请求。

前瞻目标 30 秒，2 倍速最多 60 秒；这是目标，不是每句及时完成的保证。真实研究已有 22.998 秒慢响应，超过对应批次 2 倍速末尾预算 15.980 秒。是否及时应比较批次完成时刻与第一个待显示单元的剩余播放时间，不能只看批尾。每批仍受 cue／字数上限限制。优先当前播放点，跳转清除无关待发批次；每 tab 至多一批在途、两批待发。连续模型失败立即暂停自动预取，保留原文并提供用户重试。跨 tab 沿用全局 4 执行上限，饱和时不产生无界队列。缓存键含视频、轨、文本 revision、目标语言、provider revision、模型和协议版本。

字幕层挂在播放器内部，Shadow DOM 样式隔离；以媒体时间和 requestVideoFrameCallback 切换，有事件／动画帧回退。暂停、seeked、ratechange 和 visibilitychange 后重算；正常字幕空档清空旧文字。全屏用 actual fullscreenElement 与 video/overlay 的包含关系检查，不能仅检查它的 ID。

双语默认原文加译文，未译出时显示原文及等待；迟到译文仅在对应单元仍有效时展示，不回播已结束单元，不因响应慢自动重复请求。仅译文模式未就绪时临时恢复原生。只隐藏当前播放器的原生字幕外观，不关 CC，不改原生字幕文本或网络响应。原生轨关闭时 Sayvia 也停止接管。

正常关闭、错误、换轨／视频、广告及播放器替换同步移除自有 class 和覆盖层。异常更新／失效恢复采用有限显示租约：隔离控制器仅在扩展上下文可用、授权有效、overlay 挂载可见时续租；显示租约 2 秒、每 500 ms 续租，页面侧看门狗每 250 ms 检查，过期后移除自有隐藏标记。看门狗只恢复外观、不能触发捕获或模型调用；页面可以干扰它，所以不将其当安全边界。后台冻结／页面主线程完全停止时无法保证实时恢复，页面恢复执行后先恢复再重新确认授权。扩展 reload/disable、覆盖层删除、移除播放器必须有真实测试，未通过不得写“异常恢复通过”。

## 6 查词 schema、语言和质量边界

输入为冻结原词，1～80 Unicode 码点；不自动带入选区外上下文。sourceLanguage 为 auto 或规范 BCP-47，explanationLanguage 必须为具体语言。用 Intl.getCanonicalLocales 规范化并拒绝非法标签。手动明确的语言优先于模型识别；改源语言／词／模型／释义语言立即取消旧任务和语音，旧结果失效。

LookupResult 严格对象字段：detectedLanguage 为规范 BCP-47 或 null；meanings 为 1～3 项，每项 partOfSpeech 为 ≤48 码点字符串或 null、definition 为 1～300 码点；example 为 null 或 text（1～240）及 translation（1～400）；note 为 null 或 1～240 码点。空白字符串拒绝，未知字段拒绝，JSON 文本总上限 16 KiB。UI 标注 AI 解释，明确可能有词义错误，不承诺权威词典／音标。提示约束为只解释指定源语言中原输入的含义，不迁移翻译词的其他义项；区分完整词、屈折形式、汉字／词干成分，不确定词性返回 null，不重复或凑足义项，不武断限定无上下文时的数、时态或读音。

仅一次普通 Chat Completions 请求，提示要求 JSON，本地严格校验；不强制所有兼容服务支持 JSON Schema／JSON mode。格式失败返回 FORMAT_INVALID，只有用户重试才再次调用。语音使用原始所选文字，模型不能改写待朗读单词；auto 识别只作语言建议，非 null 也不代表用户确认；朗读前须明确确认或纠正语言，可通过带具体语言名的播放按钮一次完成。未知语言仍需选择，不能默认猜声线。

生产处理器固定回归与残余风险见 [L01b 验证](validation/LEARN-production-processor.md)。自动“生”被两模型确定为中文的反例促成上述朗读语言确认规则。

首次覆盖中、英、日、韩、法、德、西七种语言；设备缺某语音只影响朗读。真实模型探针每语言五个常见／多义词、两个已有模型，格式结果与语义检查分别记录。语言扩展不等于承诺每种设备都有声线。

## 7 本地 TTS 所有权与生命周期

使用后台 chrome.tts，新增 tts、alarms 权限。仅选择 remote === false 且无其他 extensionId 的本地 voice。优先确切 locale，再允许兼容语言回退；中文书写标签与普通话／粤语单独映射，不能凭 zh 主标签跨方言选择。语音枚举最多重查 10 次、间隔 300 ms；没有匹配时明确 unavailable，不让 Chrome 默认猜选。

短纯文本上限 80 码点；常速 rate=1、慢速 rate=0.75，enqueue=false，不支持 SSML／任意 URL。按钮明确是原词的系统朗读，不代表某一义项的准确发音；词义不明的同形词不保证逐义项发音。模型失败不阻断已确认语言的本地朗读，语音失败不清空卡片。

storage.session 只保存 speechId、owner（page/manual、tab/document、nonce、cardId）、epoch、deadline，不保存文本。顶层同步注册消息／导航／关闭／alarm 监听，所有操作等待初始化 ready。发现旧租约时先 tts.stop、清理本模块 alarm 和租约，再接受新播放；不重播。后台回收时没有可靠回调，因此只能保证下一次唤醒先清理，不能承诺回收瞬间停止。

start/stop 串行；接收关闭、导航或 stop 时立即使 pending generation 失效，避免等待枚举后迟到发声。start 完成输入与 voice 校验，持久化租约并成功建立专用 alarm 后，再次检查 owner/generation 才 speak。存储／alarm 失败不播放。start callback 只判断启动错误；end/interrupted/cancelled/error 为终态。旧 callback、stop、timer、alarm 必须匹配 speechId+epoch+owner，不得停止或清理新语音。

取消先于 start 的拒绝规则：每次显式播放先获得后台签发的短期 ticket（clientSpeechId、owner、epoch、expiresAt），最长 30 秒有效；签发只登记，不枚举或播放。start 和 stop 必须携带同一 ticket。stop 即使先于 start 抵达，也把 ticket 标记 cancelled；后续 start 被拒绝。每个 epoch 至多 256 个未过期 ticket，满时拒绝新签发，不提前驱逐取消记录；过期清理后，过期 ticket 也不得重新使用。epoch 每次后台初始化重新生成，旧 epoch 一律拒绝。UI 在 ticket 尚未返回时关闭会记录本地取消，返回后仅发 stop、不发 start；若 start 已在途中，则已登记的 ticket 仍可被取消。重复 start 只返回已有状态，不重播。ticket 登记及取消操作在异步语音启动队列之外同步更新，最终 speak 前再次检查。该流程以后台接收到取消为边界，不宣称尚未送达的关闭动作已经生效。30 秒票据有效期仅限制新的 start；活动租约存续期间精确匹配 speechId／epoch／owner 的 stop 始终有效。已启动票据从待启动表移入唯一活动租约，后者不占 256 个未过期待启动／取消记录的容量；终态释放租约，过期 ticket 不能再次 start。

正常停止 timer 目标 30 秒，单次 alarm 作为非实时故障兜底。Chrome 116 打包扩展 alarm 最小 60 秒且可能延迟，不能以开发模式下更短的表现作保证；不用 Chrome 124+ onVoicesChanged 或 150+ persistAcrossSessions。仅清理当前 speechId 对应 alarm，不 clearAll；isSpeaking 不用于判断本扩展所有权。

依据独立审核读取的 [Chromium 116 alarms 定义](https://github.com/chromium/chromium/blob/116.0.5845.96/extensions/common/api/alarms.idl)、[TTS API 实现](https://github.com/chromium/chromium/blob/116.0.5845.96/chrome/browser/speech/extension_api/tts_extension_api.cc)、[语音控制器](https://github.com/chromium/chromium/blob/116.0.5845.96/content/browser/speech/tts_controller_impl.cc)。实际可听质量仍由真实声线检查，volume=0 的历史探针只证明事件。

## 8 堆叠实现与审核门槛

| 层 | 内容 | 通过条件 |
| --- | --- | --- |
| L00 | 本契约、真实探针及独立审核记录 | 初审问题逐项给出证据或明确实现契约，最终独立复审无阻塞项 |
| L01a.1 | 共用模型传输、有界输入／结果／入口协议 | 保持旧翻译行为；结构校验、非流式兼容和取消测试，不开放学习入口 |
| L01b | lookup/captions 处理器、提示、真实 Worker 校验 | 七语言真实回归、取消／截止、解码后凭证检查，无隐式二次请求 |
| L01a.2 | task/route/execution/result 联合接线（使用 L01b 处理器） | 旧翻译／手动草稿兼容；非法来源、取消和恢复测试 |
| L02a | TTS 后台与租约 | 枚举、旧 stop/回调/alarm、重启、取消先于 start、存储失败测试 |
| L02b | 页面／手动卡片与朗读入口 | 多语言、纠正语言、缺失 voice、键盘和原有翻译回归 |
| L03 | YouTube 动态注册、capture、解析和身份 | 两视频人工／ASR真实响应，新页面／已有页／站内导航及撤销 |
| L04a | 字幕批次、显式请求抢占与缓存 | 真字幕模型结果、连续播放与跳转；无旧响应或无界付费队列 |
| L04b | 覆盖层、隐藏租约及恢复 | 普通／影院／全屏、0.5/1/2倍速、关闭／失效恢复，缓存同步误差单独测量 |
| L05 | 字幕选词整合与最终回归 | 两需求实际联通，隐私文案、权限、CI及审核问题闭环 |

每个 PR 以直接上游为 base，创建后由 carter-ya 发布顶层 `@codex review`。分析每条 finding 是否适用于最新 head；有效问题修复后重新触发，误报／不需修复记录具体理由，不以暂无评论或 CI 绿代替审核。通常控制三层同时处于开发／待审核状态；在上游已有有效审核与 CI 后推进后续层。用户未授权合并，不自动合并；完整栈保留待合并，并记录较长依赖链的 head 对应关系。

普通测试使用自制结构 fixture 与模拟服务，真实字幕／真实模型／真实语音分别保存证据。没有实站证据的单项维持未验收；完成目标必须核对所有 PR 的最新 head、有效审核、CI 和未解决问题，而不是只完成文档 PR。
