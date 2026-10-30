# Sayvia

面向 GitHub 等网站的 AI 翻译 Chrome 扩展，帮助用户阅读其他语言的内容，并在原有编辑框内完成跨语言表达。

## 当前状态

当前支持模型配置与 API Key 本机永久保存，已验证浏览器重启和同 ID 更新保留，尚未提供翻译功能。首版优先适配 GitHub；Product Hunt 评论框专项适配安排在后续阶段。

## 本地开发

使用 Node 22（版本锁定见 .node-version）与 pnpm 10.21.0。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm dev
```

pnpm build 生成 .output/chrome-mv3。在 Chrome 扩展管理页打开开发者模式，选择“加载已解压的扩展程序”并加载该目录。当前可打开弹窗与设置页，尚不会向网站注入功能或调用模型。

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

S00 至 S12 是实施层号。M1 核心风险及真实模型验证通过后，再展开完整 MVP。许可证、商店上架和收费策略尚未确定。
