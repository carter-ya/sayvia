# Pull request workflow

- 创建 PR 后，使用正确的 GitHub 账号自动增加一条顶层评论 `@codex review`，显式触发审核。
- 修复推送改变 PR head 后，重新触发审核；同一 head 已有运行中的请求或已完成的有效结论时，不重复触发。
- 合并前检查 Codex 结论对应最新 head、所有有效问题已处理、CI 通过，并确认本次会话已有合并授权。暂无评论不能视为审核通过。
- 分层依赖与验证门槛见 docs/IMPLEMENTATION_PLAN.md。
