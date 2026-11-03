# Sayvia

面向 GitHub 等网站的 AI 翻译 Chrome 扩展，帮助用户阅读其他语言的内容，并在原有编辑框内完成跨语言表达。

## 当前状态

当前开发分支已接通页面内选区图标直达翻译、正式模型设置、手动粘贴与会话草稿，以及写作预览、选区／全文替换、一步恢复、取消和默认关闭的快速替换。各层 PR 的审核、CI 与合并状态分别记录，不以本机通过视为发布就绪。支持模型配置与 API Key 本机永久保存；Luna／Flash 已完成固定样例和真实扩展链路实测。M1 尚待真人语义审阅与真实 GitHub 手动提交验收。首版优先适配 GitHub；Product Hunt 评论框专项适配安排在后续阶段。

## 本地开发

使用 Node 22（版本锁定见 .node-version）与 pnpm 10.21.0。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm dev
```

pnpm build 生成 .output/chrome-mv3。在 Chrome 扩展管理页打开开发者模式，选择“加载已解压的扩展程序”并加载该目录。在设置中保存 API Key、模型和服务地址。普通网页默认可用，选中文字后点击鼠标旁的紧凑翻译图标即可开始翻译，无需逐网站或 API 主机授权。安装／更新权限由 Chrome 统一确认，可在 Chrome 扩展菜单管理网站访问。在 GitHub Issue／PR 编辑器操作栏中点击翻译图标，即可在按钮附近的浮窗翻译该框选区或全文，默认先预览再替换。工具栏“翻译当前输入”仍可作为备用入口。受限页面可在工具栏的“手动翻译”页签粘贴文本。需要快速写作时，在设置的“更多设置”提前开启快速替换；原稿变化或任务恢复时仍只预览。付费模型只在明确操作后调用，评论仍由用户自行提交。

开发包的固定 ID 为 `cjahocldgaicopmfhphamjnhbfaookam`，由 [固定公钥](config/extension-identity.ts) 写入 manifest.key，不因解压目录改变而重新生成。公钥不是模型 API Key，也不是 CRX 签名私钥。首次从未固定 ID 的旧包切换时，Chrome 会按新 ID 隔离数据，需在新扩展中重新配置模型和 Key；旧 ID 下的配置不会自动迁移。后续在同一浏览器配置中直接更新即可保留数据；卸载扩展或清除数据仍会删除配置。正式上架前应改为商店分配的公钥并核对 ID，不承诺与当前开发 ID 一致。[Chrome 官方说明](https://developer.chrome.com/docs/extensions/reference/manifest/key)

权限与入口修正见 [UX01](docs/validation/UX01.md)，玻璃外观与可移动浮窗见 [UX09](docs/validation/UX09.md)；旧验证记录均对应其注明的源提交。

在设置的“更多设置”中，可独立选择清蓝／珊瑚配色及白天／黑夜／跟随系统，默认清蓝、跟随系统。页面浮窗默认使用液态玻璃；标题栏的“浮窗外观”可切换磨砂、半透明或实色、调整背景染色浓度及阅读保护，并自动保存。拖动标题栏可避开原文，聚焦移动按钮后可用方向键微调，也可收起或恢复位置。原文与可编辑译文使用独立实底，调低玻璃背景浓度不会淡化文字，深色模式会自动增强底色以保持可读性。

## 检查与打包

| 命令              | 用途                                       |
| ----------------- | ------------------------------------------ |
| pnpm typecheck    | 生成扩展类型并检查 strict TypeScript       |
| pnpm lint         | 静态检查                                   |
| pnpm format:check | 检查代码格式，既有设计文档保持原格式       |
| pnpm test         | 先生成生产包，再验证入口、权限与脚本策略   |
| pnpm test:e2e     | 使用已构建产物，在隔离 Chromium 中验证扩展 |
| pnpm check        | 按顺序执行上述检查                         |
| pnpm build        | 构建可加载的 Chrome 扩展                   |
| pnpm zip          | 构建扩展归档                               |

首次运行 pnpm test:e2e 前先构建并安装测试浏览器。CI 使用 pnpm check；浏览器测试不使用个人配置文件、网站登录或真实模型凭证。

## 文档与开发计划

- [产品 PRD](docs/PRD.md)
- [技术方案](docs/TECHNICAL_DESIGN.md)
- [实施计划与 PR Stack](docs/IMPLEMENTATION_PLAN.md)
- [S01 验证记录](docs/validation/S01.md)
- [S02 验证记录](docs/validation/S02.md)
- [S03 验证记录](docs/validation/S03.md)
- [S04a 验证记录](docs/validation/S04a.md)
- [S04b 验证记录](docs/validation/S04b.md)
- [S05 验证记录与评估方法](docs/validation/S05.md)
- [S05 真实模型报告](docs/validation/S05-model-evaluation.md)
- [S06a 执行器验证](docs/validation/S06a.md)
- [S06b 后台调度验证](docs/validation/S06b.md)
- [S07 核心闭环验证](docs/validation/S07.md)
- [M1 验收记录与人工验证步骤](docs/validation/M1.md)
- [S08a 设置服务验证](docs/validation/S08a.md)
- [S08b 模型设置界面验证](docs/validation/S08b.md)
- [S08c 偏好与权限验证](docs/validation/S08c.md)
- [S09a 网站入口服务](docs/validation/S09a.md)
- [S09b 选区图标与阅读浮窗](docs/validation/S09b.md)
- [S09c 右键与快捷键](docs/validation/S09c.md)
- [S08d1 手动草稿服务](docs/validation/S08d1.md)
- [S08d2 手动翻译弹窗](docs/validation/S08d2.md)
- [S10 写作与快速替换](docs/validation/S10.md)
- [S11 系统回归与验收映射](docs/validation/S11.md)
- [S12 候选包与发布准备验证](docs/validation/S12.md)
- [S10b GitHub 评论框旁入口](docs/validation/S10b.md)
- [S10c 单次源语言](docs/validation/S10c.md)
- [S12b 补齐后的最终候选验证](docs/validation/S12b.md)
- [MVP 开发完成性审计](docs/validation/MVP_DEVELOPMENT_AUDIT.md)
- [30 条真实模型发布评估](docs/validation/release-model-results/README.md)
- [数据与隐私说明](PRIVACY.md)
- [发布前检查单](docs/RELEASE_CHECKLIST.md)

S00 至 S12 及补充层 S10b、S10c、S12b 是实施层号。M1 自动技术与真实模型链路验证已完成；按 2026-10-31 用户授权继续完整 MVP 开发，真人语义审阅与 GitHub 手动验收保留至正式发布前必过。许可证、商店上架和收费策略尚未确定。

阅读、写作与手动翻译默认自动识别源语言，面板可单次指定源语言；修改后需重新点击翻译。

学习功能开发分支新增查词：选择 1～80 字符的正文后，点击选区旁的查词图标；也可在工具栏“查词”页签输入。卡片只发送所选原词，展示 AI 生成的词性、释义及例句，不写回网页。可选择源语言和释义语言；自动识别只是语言建议，点击带具体语言名的朗读按钮确认后才播放。系统朗读使用设备本地声线，支持常速／慢速；缺少声线时保留释义。首期验证中、英、日、韩、法、德、西七语言，不承诺权威词典、逐义项准确发音或所有设备都有对应声音。详细结果见 [学习功能验证](docs/validation/LEARN-review-log.md)。

阅读入口：直接选中文字，点击鼠标附近的页面图标。工具栏为备用入口。右键菜单或 Ctrl+Shift+Y（macOS：Command+Shift+Y）也可翻译正文选区；快捷键可在 `chrome://extensions/shortcuts` 修改。写作快捷键默认不绑定，避免抢占其他扩展组合键。

阅读结果就绪后，支持的正文选区可点击“在网页中显示”，在当前位置阅读译文；文末“译文／原文 ···”提供切换、复制与查看，切换不会重复调用模型。网站内容变化后旧快照失效；复杂结构和源码 diff 继续提供预览与复制。只改变当前浏览器显示，刷新后恢复网站内容。行为边界与验证见 [READ01](docs/validation/READ01.md)。

发布样例评估可使用 `pnpm evaluate --provider openai --model gpt-6-luna --suite release --out NEW_FILE.jsonl`；Key 由本机 `SAYVIA_API_KEY` 环境变量提供，不写入命令参数或报告。每模型运行 30 条公开样例，报告中的人工语义与可用性保持待评。当前版本仍是预览，正式发布需完成检查单。

YouTube 学习功能开发分支：在“更多设置”开启“允许在 YouTube 读取字幕”，再到桌面普通视频页选择原语言字幕。展开播放器内的“Sayvia 字幕”，核对模型与目标语言后点击“开启双语字幕”。这次授权会持续分批发送当前播放位置附近的字幕；停止、换视频、换轨或修改当前模型后需要重新开启。支持原文＋译文、仅译文、字号与底部距离；仅译文尚未就绪或覆盖位置无法完整显示时保留原生字幕。中途开启可能需要手动刷新才能读到播放器已缓存的字幕。

双语原文中的词可点击或用键盘激活，复用查词与朗读卡片。字幕词卡固定使用该轨语言，只发送所点片段，不附带整句；分词不保证对应完整词条。查词优先于后台字幕批次，关闭卡片不会自动播放视频。无字幕、直播、Shorts、嵌入播放器及画中画不在首期范围。当前生产实站连续播放及异常恢复仍未验收，开发 PR 不代表正式发布通过。
