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

pnpm build 生成 .output/chrome-mv3。在 Chrome 扩展管理页打开开发者模式，选择“加载已解压的扩展程序”并加载该目录。在设置中保存 API Key、模型和服务地址。普通网页默认可用，选中文字后点击鼠标旁的紧凑翻译图标即可开始翻译，无需逐网站或 API 主机授权。安装／更新权限由 Chrome 统一确认，可在 Chrome 扩展菜单管理网站访问。在 GitHub Issue／PR 评论框旁点击 Sayvia“翻译”，即可翻译该框选区或全文，默认先预览再替换。工具栏“翻译当前输入”仍可作为备用入口。受限页面可在工具栏的“手动翻译”页签粘贴文本。需要快速写作时，在设置的“更多设置”提前开启快速替换；原稿变化或任务恢复时仍只预览。付费模型只在明确操作后调用，评论仍由用户自行提交。

当前体验修正与验证见 [UX01](docs/validation/UX01.md)；旧验证记录均对应其注明的源提交。

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

阅读入口：直接选中文字，点击鼠标附近的页面图标。工具栏为备用入口。右键菜单或 Ctrl+Shift+Y（macOS：Command+Shift+Y）也可翻译正文选区；快捷键可在 `chrome://extensions/shortcuts` 修改。写作快捷键默认不绑定，避免抢占其他扩展组合键。

发布样例评估可使用 `pnpm evaluate --provider openai --model gpt-6-luna --suite release --out NEW_FILE.jsonl`；Key 由本机 `SAYVIA_API_KEY` 环境变量提供，不写入命令参数或报告。每模型运行 30 条公开样例，报告中的人工语义与可用性保持待评。当前版本仍是预览，正式发布需完成检查单。
