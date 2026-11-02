# 保护元数据压缩 A/B 验证

基线：`1fcabe44e8e9c28e90011d80434aef2753981bbe`（segments-v2.1）；候选代码：`3033d3a72a3ea56fb787c3314d54ae50b69f6d28`（segments-v2.2）。

结论：保留输入压缩。普通标记用字符串表示，特殊标记保留 role 与 true 空白边界；空列表和 false 字段省略。模型输出协议及本地保护校验保持不变。

固定 17 样例初测，之后对无保护短文、Markdown 代码与链接、用户 MySQL 原句、多网址四类样例各复测两轮，交替两版请求顺序。两模型共 96 次真实请求；另有 4 次纯链接本地返回。所有请求均无自动重试。完整 system + user prompt 的实际 API usage 为统计依据，未使用字符数估算 token。

| 模型 / 阶段 | 输入：基线 → 候选 | 输出：基线 → 候选 | 总量：基线 → 候选 |
| --- | ---: | ---: | ---: |
| gpt-6-luna / initial | 6604 → 6169 | 3073 → 2842 | 9677 → 9011 |
| gpt-6-luna / focused | 3234 → 3036 | 1523 → 1200 | 4757 → 4236 |
| deepseek-flash / initial | 7139 → 6597 | 5743 → 5952 | 12882 → 12549 |
| deepseek-flash / focused | 3506 → 3258 | 3338 → 3137 | 6844 → 6395 |

按全部实际调用合计，OpenAI 输入减少 6.4%、总 token 减少 8.2%；DeepSeek 输入减少 7.4%、总 token 减少 4.0%。复测样例在合计中具有额外权重；两阶段分列，不能把合计百分比当作真实用户流量的固定降幅。每个实际请求配对的输入都减少；两个模型在两个阶段的总 token 都下降。

输出与推理 token 有明显随机波动。例如 MySQL 原句的 DeepSeek 三次配对合计总 token 为 2719 → 2867，虽然其每次输入都是 419 → 396。没有证据保证单次输出、总量、费用或延迟稳定下降。此次保留的是确定减少请求输入、且在两组实测总体有正收益的压缩；不宣称每个请求都节省总 token。

全部 100 条运行结果均成功重建并通过保护内容检查。代理逐项比较记录译文，未发现候选新增的明显否定、数字、含义或结构退步；一个 OpenAI 基线复测漏掉未标记为代码的 JSON_*，候选保留了它，该单次差异不作为普遍质量提升证据。发布前人工语义、可用性验收仍待完成。

369 项单元测试和 Chrome 156.0.8078.80 的 96 项浏览器回归通过；类型、lint、格式检查通过。30 条发布语料的保护元数据可无损展开为原完整字段，缺失、重复、未知或乱序标记仍由原校验拒绝。

[逐样例数据](payload-compact-20261102.json) 只包含公开语料、译文、usage 及请求散列；原始报告留在本机忽略目录（0600），未提交 Key、认证头或环境文件。

复现方式：导出基线 src/core、src/providers、src/evaluation 到独立目录，并将其 node_modules 链接到已安装的当前依赖；设置本机 SAYVIA_API_KEY 后执行（会产生真实模型调用费用）：

```sh
pnpm exec tsx scripts/compare-payload.ts --baseline-dir /path/to/baseline --provider openai --model gpt-6-luna --out evaluation-results/NEW-openai.jsonl
pnpm exec tsx scripts/compare-payload.ts --baseline-dir /path/to/baseline --provider deepseek --model deepseek-flash --out evaluation-results/NEW-deepseek.jsonl
```

复测再加 `--sample m1-02 --sample m1-03 --sample mysql-url --sample multiple-urls --rounds 2`，输出文件必须是新文件。usage 缺失、保护失败或请求错误时停止，不自动付费重试。

usage 字段依据 [OpenAI 官方 Chat Completions 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。prompt_tokens 为输入，completion_tokens 为生成开销，total_tokens 为合计；不是只统计界面可见的译文。
