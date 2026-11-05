import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  SpeechTicketSchema,
  type SpeechSource,
  type SpeechTicket,
  type SpeechState,
} from '../runtime/speech-protocol';

type Playback = {
  source: SpeechSource;
  ticket?: SpeechTicket;
  canceled: boolean;
  stopSent: boolean;
  terminal: boolean;
};
const send = (type: string, payload: unknown) =>
  browser.runtime.sendMessage({
    type,
    payload,
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
  });
const terminal = new Set(['ended', 'canceled', 'unavailable', 'failed']);
export function useLocalSpeech(source: SpeechSource, text: string, language: string | undefined) {
  const current = useRef<Playback | undefined>(undefined);
  const [state, setState] = useState<SpeechState>('ended');
  const sendStop = (playback: Playback) => {
    if (!playback.ticket || playback.stopSent) return;
    playback.stopSent = true;
    void send('speech.stop', { source: playback.source, ticket: playback.ticket }).catch(
      () => undefined,
    );
  };
  const cancel = () => {
    const playback = current.current;
    current.current = undefined;
    if (!playback) return;
    playback.canceled = true;
    sendStop(playback);
  };
  const sourceKey = JSON.stringify(source);
  useEffect(() => {
    setState('ended');
    const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
    ) => {
      const playback = current.current;
      if (
        sender.id !== browser.runtime.id ||
        sender.url !== browser.runtime.getURL('/background.js') ||
        message?.type !== 'speech.state' ||
        !playback?.ticket ||
        playback.canceled
      )
        return;
      const ticket = SpeechTicketSchema.safeParse(message.ticket);
      if (
        !ticket.success ||
        ticket.data.speechId !== playback.ticket.speechId ||
        ticket.data.epoch !== playback.ticket.epoch ||
        ticket.data.expiresAt !== playback.ticket.expiresAt ||
        message.cardId !== playback.source.cardId ||
        message.documentNonce !== playback.source.documentNonce ||
        (playback.source.origin === 'manual' && message.tabId !== playback.source.tabId)
      )
        return;
      if (message.state !== 'speaking' && !terminal.has(message.state)) return;
      if (playback.terminal) return;
      playback.terminal = terminal.has(message.state);
      setState(message.state as SpeechState);
    };
    browser.runtime.onMessage.addListener(listener);
    window.addEventListener('pagehide', cancel);
    return () => {
      cancel();
      browser.runtime.onMessage.removeListener(listener);
      window.removeEventListener('pagehide', cancel);
    };
  }, [sourceKey, text, language]);
  async function play(rate: 1 | 0.75) {
    if (!language || !text.trim() || [...text.trim()].length > 80) return;
    cancel();
    const playback: Playback = { source, canceled: false, stopSent: false, terminal: false };
    current.current = playback;
    setState('starting');
    try {
      const reply = (await send('speech.ticket', {
        source,
        clientSpeechId: crypto.randomUUID(),
      })) as { ok?: boolean; data?: unknown };
      if (!reply?.ok) throw new Error('UNAVAILABLE');
      playback.ticket = SpeechTicketSchema.parse(reply.data);
      if (playback.canceled) {
        sendStop(playback);
        return;
      }
      const started = (await send('speech.start', {
        source,
        ticket: playback.ticket,
        input: { text, language, languageConfirmed: true, rate },
      })) as { ok?: boolean; data?: { state: SpeechState } };
      if (playback.canceled || current.current !== playback || playback.terminal) return;
      if (!started?.ok || !started.data) throw new Error('UNAVAILABLE');
      playback.terminal = terminal.has(started.data.state);
      setState(started.data.state);
    } catch {
      // The request may have reached the background even if its reply was lost.
      sendStop(playback);
      if (current.current === playback && !playback.canceled) {
        playback.terminal = true;
        setState('failed');
      }
    }
  }
  return {
    state,
    play,
    stop: () => {
      cancel();
      setState('canceled');
    },
  };
}
