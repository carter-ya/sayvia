import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { LookupInputSchema, type LookupResult } from '../core/learning-contract';
import { LearningEventSchema } from '../runtime/public-events';
import { userError } from '../runtime/user-errors';
import { LanguageField } from './LanguageField';
import { LookupDetails } from './LookupDetails';
import { TranslationLoading } from './TranslationLoading';

const send = (type: string, payload: unknown) =>
  browser.runtime.sendMessage({
    type,
    payload,
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  });
export function LookupPanel({
  text,
  documentNonce,
  onClose,
}: {
  text: string;
  documentNonce: string;
  onClose(): void;
}) {
  const [sourceLanguage, setSource] = useState('auto');
  const [target, setTarget] = useState('zh-Hans');
  const [result, setResult] = useState<LookupResult>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('正在准备查词…');
  const [model, setModel] = useState('');
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const focused = useRef(false);
  const current = useRef<{ id: string; canceled: boolean } | undefined>(undefined);
  const cancelRequest = () => {
    const request = current.current;
    current.current = undefined;
    if (!request || request.canceled) return;
    request.canceled = true;
    void send('translation.cancel', { clientTaskId: request.id, documentNonce }).catch(
      () => undefined,
    );
  };
  async function lookup(source: string, explanation: string) {
    const input = LookupInputSchema.safeParse({
      text,
      sourceLanguage: source,
      explanationLanguage: explanation,
    });
    if (!input.success) {
      setStatus('请选择有效的语言，单词或短语需为 1～80 字符。');
      return;
    }
    cancelRequest();
    const request = { id: crypto.randomUUID(), canceled: false };
    current.current = request;
    setAttempt((value) => value + 1);
    setResult(undefined);
    setBusy(true);
    setStatus('正在查词…');
    try {
      const reply = (await send('learning.start', {
        purpose: 'lookup',
        origin: 'page',
        clientTaskId: request.id,
        documentNonce,
        input: input.data,
      })) as { ok?: boolean; error?: string; data?: { state: string; error?: string } };
      if (!mounted.current || request.canceled || current.current !== request) return;
      if (!reply?.ok) throw new Error(reply?.error ?? 'CONTEXT_LOST');
      if (reply.data?.error) throw new Error(reply.data.error);
      if (reply.data && !['running', 'ready', 'delivered'].includes(reply.data.state)) {
        setBusy(false);
        setStatus('查词已停止，可重新查词。');
      }
    } catch (error) {
      if (mounted.current && !request.canceled && current.current === request) {
        setBusy(false);
        setStatus(userError(error));
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
      reply,
    ) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.url !== browser.runtime.getURL('/background.js')
      )
        return;
      const parsed = LearningEventSchema.safeParse(message);
      const request = current.current;
      if (
        !parsed.success ||
        !request ||
        request.canceled ||
        parsed.data.clientTaskId !== request.id ||
        parsed.data.documentNonce !== documentNonce
      )
        return;
      const event = parsed.data;
      if (event.type === 'learning.result' && event.result.data.purpose === 'lookup') {
        setResult(event.result.data.value);
        setBusy(false);
        setModel(event.provider.model);
        setStatus('AI 释义已就绪。');
      } else if (event.type === 'learning.state') {
        setBusy(false);
        setStatus(
          event.state === 'canceled' ? '查词已取消。' : userError(event.error ?? 'CONTEXT_LOST'),
        );
      }
      reply({ taskId: event.taskId, documentNonce });
    };
    browser.runtime.onMessage.addListener(listener);
    void browser.runtime
      .sendMessage({ protocolVersion: 1, requestId: crypto.randomUUID(), type: 'page.preferences' })
      .then(
        (reply: { ok?: boolean; data?: { readTarget?: string } }) => {
          if (!mounted.current) return;
          const explanation =
            reply?.ok && reply.data?.readTarget ? reply.data.readTarget : 'zh-Hans';
          setTarget(explanation);
          setReady(true);
          void lookup('auto', explanation);
        },
        () => {
          if (mounted.current) {
            setReady(true);
            setStatus('页面连接暂不可用，请重新查词。');
          }
        },
      );
    return () => {
      mounted.current = false;
      cancelRequest();
      browser.runtime.onMessage.removeListener(listener);
    };
  }, []);
  const change = (source: string, explanation: string) => {
    cancelRequest();
    setBusy(false);
    setResult(undefined);
    setSource(source);
    setTarget(explanation);
    setStatus('语言已更新，点击查词获取新释义。');
  };
  return (
    <section
      role="dialog"
      aria-label="查词"
      tabIndex={-1}
      ref={(element) => {
        if (element && !focused.current) {
          focused.current = true;
          element.focus();
        }
      }}
    >
      <header className="lookup-header" data-panel-drag>
        <strong>查词</strong>
        <button type="button" className="secondary" data-panel-move aria-label="移动查词浮窗">
          移动
        </button>
        <button
          type="button"
          className="secondary"
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) onClose();
          }}
        >
          关闭查词
        </button>
      </header>
      <p className="lookup-word">{text}</p>
      <div className="lookup-selectors">
        <LanguageField
          label="源语言"
          value={sourceLanguage}
          allowAuto
          disabled={!ready}
          onChange={(language) => change(language, target)}
        />
        <LanguageField
          label="释义语言"
          value={target}
          disabled={!ready}
          onChange={(language) => change(sourceLanguage, language)}
        />
      </div>
      {busy && <TranslationLoading label="正在查词" />}
      <LookupDetails
        text={text}
        sourceLanguage={sourceLanguage}
        result={result}
        owner={{ origin: 'page', documentNonce }}
        identity={`${target}:${attempt}`}
      />
      <div className="lookup-actions">
        <button
          type="button"
          disabled={!ready || busy}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) void lookup(sourceLanguage, target);
          }}
        >
          重新查词
        </button>
        {busy && (
          <button
            type="button"
            className="secondary"
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) {
                cancelRequest();
                setBusy(false);
                setStatus('查词已取消。');
              }
            }}
          >
            取消查词
          </button>
        )}
      </div>
      <p role="status">{status}</p>
      {model && <p className="field-help">{model}</p>}
    </section>
  );
}
