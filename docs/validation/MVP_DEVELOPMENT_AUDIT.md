# MVP 开发完成性审计

日期：2026-11-01。审计依据是 PRD、技术方案和实施计划；人工验收依用户授权保留至发布前。这里区分“实现及自动证据具备”和“发布验收通过”，不把后者缩减为前者。

## 已确认需求 C01–C10

| 要求 | 当前证据 | 限制／剩余门槛 |
| --- | --- | --- |
| C01 品牌 Sayvia | manifest、README、正式设置与弹窗、独立 SVG/PNG 图标 | 商店和许可证仍由用户决定 |
| C02 网站内容翻译 | DOM 选区提取、正文浮窗、网站授权；selection-entry、dom-selection 浏览器测试 | Product Hunt 评论框专项适配属 P1，不宣称已完成 |
| C03 编辑框到指定目标语言 | workflow、TextEditorSession；core-workflow、quick-replace、source-language | 真实 GitHub 站点提交仍待人工 |
| C04 复制或精确替换 | 实际剪贴板粘贴、受控表单状态、选区／全文与恢复冲突测试 | 扩展没有发送网站评论的实现 |
| C05 两家真实 AI | Luna／Flash 各 30 条固定真实报告，S07 真实扩展链路；本次原生 Luna 操作 | 格式保护通过不等同真人语义评分 |
| C06 自定义兼容服务 | endpoint 规范化、配置、协议适配和本地 Chat Completions 实际扩展测试 | 支持文档定义协议，不承诺任意接口、OAuth 或自定义头 |
| C07 项目内 Markdown PRD | docs/PRD.md 由仓库跟踪 | 满足保存位置和格式要求 |
| C08 Key 永久保存 | config-persistence 浏览器重启／同 ID 更新、后台重启；原生同 ID 重载后原 Key 可真实请求 | 物理设备重启和正式升级人工验收未完成；不承诺加密或卸载后保留 |
| C09 首版范围 | GitHub Issue／PR Markdown adapter、通用普通输入框及明确手动降级 | Discussions 未实站验证时不启用专项回写 |
| C10 选区图标直达 | selection-entry 真实鼠标测试；原生 Docs 选区图标直接显示 Luna 译文 | 主路径不要求工具栏；右键／快捷键为补充入口 |

## P0 功能与交互约束

| 范围 | 实现与匹配验证 |
| --- | --- |
| F01、F07 配置、测试与默认模型 | settings-services、settings-ui、config-repository、chat-completions；请求域名来自保存配置，测试连接只发固定公开短句 |
| F02 独立读写目标 | preferences-permissions；S10c 单次源语言默认 auto、手动值和会话恢复，不改变永久目标偏好 |
| F03 正文原译文、复制和关闭 | selection-entry、source-language；DOM 代码／标识符留本机，译文作为文本，不回写原站 |
| F04、PRD 4.4 GitHub 写作入口 | S10b 评论框旁按钮、动态去重、当前按钮绑定的草稿选区；editor-entry 模拟真实 GitHub origin 验证，不拿工具栏替代此入口 |
| F05 预览、修改、复制、替换和恢复 | core-workflow、focus-and-clipboard、editor-safety；修改再撤回、重渲染、焦点变化、恢复冲突均保持保护 |
| F06 快速替换 | 默认关闭；启动读取当前偏好、结果时再次核对；quick-replace 覆盖成功、原稿变化、等待中关闭、格式错误、限流 |
| F08 入口、状态、取消和重试 | gesture-entry、task-runtime、manual-popup；原生菜单／⌘⇧Y、受限页与无选区验证；重试必须再次主动触发 |
| F09 授权、隔离和防覆盖 | site-access、site-entry、task-router、executor、task-broker；凭证不进页面／popup DTO，API 授权不自动开启网站捕获 |
| 受限页／不支持编辑器 | 正式手动页；正文、候选和语言会话保存，冲突／清理／迟到回复不恢复旧数据，关闭不会主动取消或重发 |
| PRD 6 格式与边界 | source-input、translation-plan、dom-selection；12,000 Unicode 字符、不截断、空白／保护-only 无模型请求、输出结构校验不通过不写草稿 |
| PRD 9 数据边界 | TRUSTED_CONTEXTS、CSP、本地 Worker、HTTPS／回环授权、无凭证重定向；包审计无 Key、环境或个人会话；无使用分析上传 |
| PRD 11 页面行为与可访问性 | 同文档导航／重复注入、任务共用标签页互斥、Tab、真实剪贴板、明暗与窄窗口；源语言新增控件有键盘顺序及可见按钮验证 |

A01–A20 的原始对应和人工缺口保留在 [S11](S11.md)，补齐后的最后完整自动计数、原生 UI、安装包与反馈实测以 [S12b](S12b.md) 为准：334 项单元、两代 Chrome 各 87 项浏览器。触发反馈的 headless 记录不能当作已做真人桌面性能验收。

## 审核、合并与发布审计

创建及每个变更 head 后使用 carter-ya 连接评论 `@codex review`；同 head 不重复触发。最新代码的已有 PR 审核均无有效发现，但合并仍须现场核对 head、未解决问题和 CI，并保持依赖次序。提交元数据为 carter_ya / carter_ya@proton.me。最终记录层本身仍须创建 PR 并取得审核与 CI，不能由文档自我批准。

各层是否已合并应以 GitHub 的最新状态为准；首轮 Linux CI 暴露的快速替换测试时序假设已按 S12b 记录修正并重新提交审核。不得拿本机结果替代最新远端通过，也不改写检查绕过门槛。用户真实配置及原生 Chrome 使用中的 worktree 必须保留。

发布仍不满足：真人语义／可用性、PRD 八种目标语言与显式源语言的真实质量、真实 GitHub 手动提交、物理设备重启、原生输入法／点击外部关闭／取消和快捷键冲突细节，及全部 PR 门槛。原生 Docs 的临时授权已按用户要求撤销，API 授权与原 Key 保留。继续依据 [发布前检查单](../RELEASE_CHECKLIST.md)，不把这些项目记为已过，也不在本阶段发布或上架。
