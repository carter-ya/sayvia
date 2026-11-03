import { useMemo } from 'react';
import type { LookupResult } from '../core/learning-contract';
import { languageName } from './languages';
import { useLocalSpeech } from './use-local-speech';
import type { SpeechSource } from '../runtime/speech-protocol';

export function LookupDetails({
  text,
  sourceLanguage,
  result,
  owner,
  identity,
}: {
  text: string;
  sourceLanguage: string;
  result?: LookupResult | undefined;
  owner: { origin: 'page'; documentNonce: string } | { origin: 'manual'; tabId: number };
  identity: string;
}) {
  const ownerKey = JSON.stringify(owner);
  const source = useMemo<SpeechSource>(
    () =>
      owner.origin === 'manual'
        ? { ...owner, cardId: crypto.randomUUID(), documentNonce: crypto.randomUUID() }
        : { ...owner, cardId: crypto.randomUUID() },
    [ownerKey, identity, text, sourceLanguage],
  );
  const language =
    sourceLanguage === 'auto' ? (result?.detectedLanguage ?? undefined) : sourceLanguage;
  const speech = useLocalSpeech(source, text, language);
  const speaking = speech.state === 'starting' || speech.state === 'speaking';
  const label = language ? languageName(language) : '';
  return (
    <div className="lookup-details">
      <style>{`.lookup-header button {width:auto; height:auto; min-height:30px; white-space:nowrap; flex-shrink:0; padding:4px 7px;}`}</style>
      <style>{`.lookup-details {margin:10px 0; overflow-wrap:anywhere;} .lookup-audio,.lookup-actions,.lookup-header {display:flex; flex-wrap:wrap; align-items:center; gap:6px;} .lookup-header strong {margin-right:auto;} .lookup-selectors {display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px;} .lookup-word {font-size:20px; font-weight:650; overflow-wrap:anywhere; background:var(--field); padding:10px; border-radius:10px;} .lookup-meanings {padding-left:22px; background:var(--field); border-radius:10px; padding-top:8px; padding-bottom:8px;} .lookup-meanings li {padding:5px 8px 5px 0; line-height:1.6;} .lookup-pos {display:inline-block; margin-right:8px; font-size:11px; color:var(--muted); padding:1px 5px; border:1px solid var(--line); border-radius:5px;} .lookup-example {background:var(--field); padding:8px 10px; border-radius:8px;} .lookup-example p {margin:3px 0;} .lookup-note {color:var(--muted);}`}</style>
      <div className="lookup-audio" aria-label="系统朗读">
        <button
          type="button"
          disabled={!language || !text.trim() || [...text.trim()].length > 80 || speaking}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) void speech.play(1);
          }}
        >
          {language ? `按${label}朗读` : '先选择朗读语言'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!language || !text.trim() || [...text.trim()].length > 80 || speaking}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) void speech.play(0.75);
          }}
        >
          {language ? `按${label}慢速朗读` : '慢速朗读'}
        </button>
        {speaking && (
          <button
            type="button"
            className="secondary"
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) speech.stop();
            }}
          >
            停止朗读
          </button>
        )}
      </div>
      {sourceLanguage === 'auto' && language && (
        <p className="field-help">识别为{label}。点击朗读即确认此语言；不正确时请修改源语言。</p>
      )}
      {!language && <p className="field-help">请选择源语言后朗读；自动识别不能确定语言。</p>}
      <p className="field-help" role="status">
        {speech.state === 'unavailable'
          ? '设备没有匹配的本地声线，仍可查看释义。请在系统设置安装对应语言的语音，再点击朗读重新检测。'
          : speech.state === 'failed'
            ? '系统朗读暂不可用，可重试或检查设备声线。'
            : speech.state === 'starting'
              ? '正在准备本地声线…'
              : speech.state === 'speaking'
                ? '正在朗读…'
                : ''}
      </p>
      {result && (
        <div aria-label="AI 释义">
          <ol className="lookup-meanings">
            {result.meanings.map((meaning, index) => (
              <li key={index}>
                {meaning.partOfSpeech && <span className="lookup-pos">{meaning.partOfSpeech}</span>}
                <span>{meaning.definition}</span>
              </li>
            ))}
          </ol>
          {result.example && (
            <div className="lookup-example">
              <p lang={language}>{result.example.text}</p>
              <p>{result.example.translation}</p>
            </div>
          )}
          {result.note && <p className="lookup-note">{result.note}</p>}
        </div>
      )}
      <p className="field-help">
        AI 释义可能有误。系统合成语音朗读原词，不保证多义词每个义项的读音。
      </p>
    </div>
  );
}
