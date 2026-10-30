# S05 真实模型小样本评估

- 日期：2026-10-30；首轮北京时间 22:36，修正后复测 22:58。
- 服务／模型：OpenAI gpt-6-luna、DeepSeek deepseek-flash，官方默认 Base URL。
- 样例：固定 m1-12-v1，自制公开数据，三种来源、两个语言方向，各模型每轮同样 12 条。
- 首轮代码：7c505b780a2b83eab13e4be0e3e0cfd112d18d8e；复测代码：f133aae21a897d7544b7fb7de3ee59dbc287de79。
- 请求配置：Chat Completions；system + user；stream:false；未显式覆盖推理、temperature 或输出 token 参数；模型名称为请求别名，未保留服务返回的底层快照标识。
- 调用记录：首轮 24 次 + 算法修正后复测 24 次，共 48 次；无失败、无自动重试、无服务切换。没有采集实际账单或 token 用量，不推算真实费用。

## 自动验证结果

| 算法 | 模型 | 首次结构成功 | 保护通过 | 端到端中位耗时 | 最大耗时 |
| --- | --- | --- | --- | --- | --- |
| segments-v1 | gpt-6-luna | 12/12 | 12/12 | 2.71 s | 4.12 s |
| segments-v1 | deepseek-flash | 12/12 | 12/12 | 1.26 s | 3.97 s |
| segments-v2 | gpt-6-luna | 12/12 | 12/12 | 2.97 s | 8.32 s |
| segments-v2 | deepseek-flash | 12/12 | 12/12 | 1.69 s | 19.35 s |

耗时来自本机工具接纳至请求、解析和重建完成，含本地处理，不含人工审阅。所有 48 次均在 60 秒以内。12 条样例只验证可行性，不代表稳定延迟、广泛语言覆盖或发布质量。

## 首轮发现与整改

segments-v1 的结构及保护均通过，但两模型在 m1-03、m1-06、m1-07 都出现同一类拼接缺陷：read[configuration guide]、View[Installation instructions]、This**is not**a。不能凭结构成功率判定译文可用。

根因是代码／样式两侧分别翻译且禁止片段边缘空格。S04b 改为完整行上下文和有角色的保护标记；模型可调整组内语序和普通空格，保护标记必须完整、唯一、同序。换行、缩进、代码、URL、引用目的地仍从本地原文恢复，并复查 AST。S05 同步更新提示词并将算法记为 segments-v2。

复测中两模型上述 3 条粘连均消失；m1-10 的条件也能自然移至标识符之前。所有首轮结果保留，未以重跑结果覆盖失败特征。

## Codex 逐条语义审阅

以下为 Codex 的 AI 审阅，关注否定、条件、数字、承诺与可用性；不是独立真人签字。原始 CLI 记录保留 semanticReview/usabilityReview:pending、manualReviewPending:true、m1Passed:false，避免把自动结果伪装成人工验收。

复测初评：Luna 9 条可直接使用、3 条轻改；Flash 8 条可直接使用、4 条轻改；均未发现严重语义反转，12/12 达到可用或轻改范围。自然度、术语及语气仍需在产品流程中复核。

| 样例 | 服务 | Codex 判断与建议 |
| --- | --- | --- |
| m1-01 | openai | 可直接使用；条件、否定、3 与 5 保持。 |
| m1-02 | openai | 可直接使用；技术词、可能性与未确认语气保持。 |
| m1-03 | openai | 可直接使用；代码与 URL 不变，链接前空格自然。 |
| m1-04 | openai | 可直接使用；禁止增加重试及失败条件保持。 |
| m1-05 | openai | 轻改；建议 Run tests afterward，避免 again 额外暗示重复。 |
| m1-06 | openai | 可直接使用；图片说明、链接标签与目的地正确。 |
| m1-07 | openai | 可直接使用；否定与强调保持，首轮粘连已消失。 |
| m1-08 | openai | 可直接使用；not promised 保留未承诺状态。 |
| m1-09 | openai | 轻改；Please ask @carter-ya to review 更自然；否定未变。 |
| m1-10 | openai | 轻改；标识符场景优先用“读取”而非“阅读”。 |
| m1-11 | openai | 可直接使用；代码、数字、缩进与否定保持。 |
| m1-12 | openai | 可直接使用；没有把不会自动保存反转。 |
| m1-01 | deepseek | 可直接使用；条件、否定及重试数字保持。 |
| m1-02 | deepseek | 轻改；建议“高负载时，超时时间可能增加”。 |
| m1-03 | deepseek | 可直接使用；代码、URL 与自然链接空格正确。 |
| m1-04 | deepseek | 可直接使用；条件与暂不增加重试保持。 |
| m1-05 | deepseek | 轻改；Back up 动词形式及 afterward 比 again 更贴切。 |
| m1-06 | deepseek | 可直接使用；图片说明、引用标签与目的地正确。 |
| m1-07 | deepseek | 可直接使用；否定、强调、实体、转义及 HTML 保持。 |
| m1-08 | deepseek | 轻改；uncommitted 有 Git 歧义，建议 no commitment。 |
| m1-09 | deepseek | 轻改；建议 Please ask @carter-ya to review；地址与否定保持。 |
| m1-10 | deepseek | 可直接使用；条件已自然移到标识符前。 |
| m1-11 | deepseek | 可直接使用；代码完整、缩进不变、否定保持。 |
| m1-12 | deepseek | 可直接使用；明确不会自动保存。 |

## 可复查记录

以下 JSONL 是完整的评估工具输出，仅含公开样例、接受后的译文、计时与状态；不含 Key、完整 API 响应、请求头或私有网页内容。发布前已检查不含本机配置的两家 Key。

- [segments-v1 / gpt-6-luna](./s05-model-results/segments-v1-openai.jsonl)
- [segments-v1 / deepseek-flash](./s05-model-results/segments-v1-deepseek.jsonl)
- [segments-v2 / gpt-6-luna](./s05-model-results/segments-v2-openai.jsonl)
- [segments-v2 / deepseek-flash](./s05-model-results/segments-v2-deepseek.jsonl)

## 阶段边界

这组真实样例支持当前候选算法继续 code review，不能宣告完整 M1 通过。真实 DOM 采集到模型再回到网页的扩展链路、Offscreen 与后台恢复、主机授权、GitHub 实页手动提交、完整译文编辑后的校验仍须 S06/S07 验证；真人语义验收仍未完成。S05 PR 的 review 也不能代替这些门槛。
