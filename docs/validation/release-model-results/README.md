# 发布模型质量记录

日期：2026-11-01。固定数据集：release-30-v1；算法：segments-v2.1。sourceRevision 与数据集 SHA-256 见各 JSONL 的首行及 summary.json。前 12 条保持 M1 数据不变，新增 18 条在执行前固定，覆盖纯文本、Markdown 与 DOM 选区（9／12／9）。

两个模型各执行 30 次真实请求，每例一次，无重试、无事后挑选。模型由用户指定；调用凭证只通过本机进程环境提供，未写入此目录。所有源文与参考含义均为自制公开文本。

| 模型 | 成功／结构保护 | 中位耗时 | P95 | 最长 | 真人语义／可用性 |
| --- | --- | --- | --- | --- | --- |
| gpt-6-luna | 30/30 | 2240.5 ms | 4121 ms | 8562 ms | 待评 |
| deepseek-flash | 30/30 | 1663.5 ms | 6009 ms | 8082 ms | 待评 |

“结构通过”只表示协议、重建、保护内容和时限满足检查，不证明译文已经自然、准确。每项 semanticReview／usabilityReview 保持 pending，summary.releaseReady 保持 false。人工标准：每模型至少 27/30 可直接使用或轻微修改后使用，保护内容 100%，且无严重语义错误。不能将 AI 初筛当作真人结论。

## AI 初筛注意项（非人工评分）

已逐条对照本次 60 项源文、参考含义和输出。未观察到明显的否定、数字、默认开关或发布承诺反转，仍应由真人独立判断，尤其关注：

- m1-02：Flash 的“超时可能会增多”需确认是否把时长理解成次数；原英文存在语境歧义。
- m1-03：Luna 的英文链接标签前措辞可补冠词。
- m1-08：Flash 的 uncommitted 可能带来 Git 提交语义歧义，宜评审发布承诺表达。
- m1-10：两个模型的“阅读 timeout”是否应调整为技术语境下的“读取 timeout”。
- release-23：Luna 在链接与代码间的英文语序略生硬；Flash 的 real Key 可考虑自然化为 real API keys。

这些是 AI 观察，不预填“通过／轻微修改”，也不代替对其余样例的人工检查。原始结果不做润色、不改写，以便复核。

## 复现与人工记录

```sh
SAYVIA_API_KEY=... pnpm evaluate --provider openai --model gpt-6-luna --suite release --out NEW_OPENAI.jsonl
SAYVIA_API_KEY=... pnpm evaluate --provider deepseek --model deepseek-flash --suite release --out NEW_DEEPSEEK.jsonl
```

建议通过本机环境文件注入 Key，不把真实值写到可共享命令历史或聊天。输出路径必须为新文件；CLI 拒绝覆盖现有报告，文件权限 0600。每次重新执行会产生真实 API 调用和服务商费用，不因仅重新打开评审材料而调用模型。

人工逐条记录四类结果：可直接使用、轻微修改可用、需大幅修改、严重语义错误；记录评审者、日期、模型与样例 ID，保留修改意见。提供的本地 HTML 人评表默认未评分，只在本机保留进度并导出评分 JSON，不联网；导出评分不等于正式发布批准。真实 GitHub 手动提交、原生入口、最终包和 CI 仍单独验收。
