import { useEffect, useState } from 'react';
import type { ResultMetrics, TranslationProgress } from '../runtime/translation-progress';
export function TranslationMetrics({
  busy,
  startedAt,
  progress,
  result,
}: {
  busy: boolean;
  startedAt?: number | undefined;
  progress?: TranslationProgress | undefined;
  result?: ResultMetrics | undefined;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [busy]);
  if (!busy && !result?.requested) return null;
  const duration = busy
    ? Math.max(progress?.elapsedMs ?? 0, startedAt ? now - startedAt : 0)
    : (result?.durationMs ?? 0);
  const usage = busy ? progress?.usage : result?.usage;
  const estimates = busy ? progress?.estimates : result?.estimates;
  const phase = busy
    ? { connecting: '连接中', thinking: '思考中', translating: '生成中', validating: '校验中' }[
        progress?.phase ?? 'connecting'
      ]
    : '已完成';
  return (
    <p className="translation-metrics" aria-label="翻译用量">
      {phase} · {(Math.max(0, duration) / 1000).toFixed(1)} s ·{' '}
      {usage
        ? `输入 ${usage.inputTokens.toLocaleString()} / 输出 ${usage.outputTokens.toLocaleString()} token${usage.reasoningTokens !== undefined ? `（含推理 ${usage.reasoningTokens.toLocaleString()}）` : ''}`
        : estimates
          ? `估算输入 ${estimates.inputTokens.toLocaleString()} / 输出 ${estimates.outputTokens.toLocaleString()} token`
          : '等待用量信息'}
    </p>
  );
}
