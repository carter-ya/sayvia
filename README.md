# Sayvia

面向 GitHub 等网站的 AI 翻译 Chrome 扩展，帮助用户阅读其他语言的内容，并在原有编辑框内完成跨语言表达。

## 当前状态

当前已接通最小阅读与写作翻译：原文预览、目标语言、候选编辑、复制、选区／全文替换、一步恢复及取消。支持模型配置与 API Key 本机永久保存；Luna／Flash 已完成固定样例和真实扩展链路实测。M1 尚待真人语义审阅与真实 GitHub 手动提交验收。首版优先适配 GitHub；Product Hunt 评论框专项适配安排在后续阶段。

## 本地开发

使用 Node 22（版本锁定见 .node-version）与 pnpm 10.21.0。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm dev
```

pnpm build 生成 .output/chrome-mv3。在 Chrome 扩展管理页打开开发者模式，选择“加载已解压的扩展程序”并加载该目录。在设置中保存模型配置，并点击“授权此 API 主机”。回到网页，选中文字或聚焦编辑框，再从工具栏选择阅读／写作翻译；核对原文后点击翻译。付费模型只在明确操作后调用，评论仍由用户自行提交。

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

S00 至 S12 是实施层号。M1 自动技术与真实模型链路验证已完成；按 2026-10-31 用户授权继续完整 MVP 开发，真人语义审阅与 GitHub 手动验收保留至正式发布前必过。许可证、商店上架和收费策略尚未确定。
