// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Preconnection, PRECONNECT_TTL_MS } from '../../src/executor/preconnection';

afterEach(() => {
  vi.useRealTimers();
  document.head.innerHTML = '';
});
describe('bounded model preconnection', () => {
  it('creates a credential-free hint, deduplicates without extending its life, and expires once', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const connection = new Preconnection(document, expired);
    connection.warm('https://api.example.test');
    const link = document.querySelector('link')!;
    expect(link.rel).toBe('preconnect');
    expect(link.crossOrigin).toBe('anonymous');
    expect(link.href).toBe('https://api.example.test/');
    vi.advanceTimersByTime(PRECONNECT_TTL_MS - 1);
    connection.warm('https://api.example.test');
    expect(document.querySelector('link')).toBe(link);
    vi.advanceTimersByTime(1);
    expect(connection.active).toBe(false);
    expect(document.querySelector('link')).toBeNull();
    expect(expired).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('replaces the hint on origin change, and cleans up without polling', () => {
    vi.useFakeTimers();
    const expired = vi.fn();
    const connection = new Preconnection(document, expired);
    connection.warm('https://one.test');
    connection.warm('https://two.test');
    expect(document.querySelectorAll('link')).toHaveLength(1);
    expect(document.querySelector('link')!.href).toBe('https://two.test/');
    connection.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(expired).not.toHaveBeenCalled();
  });
  it.each([
    'https://user:secret@example.test',
    'https://example.test/v1',
    'http://remote.test',
    'https://example.test/?key=secret',
  ])('rejects a destination other than an allowed origin: %s', (origin) => {
    const connection = new Preconnection(document, vi.fn());
    expect(() => connection.warm(origin)).toThrow();
    expect(document.querySelector('link')).toBeNull();
  });
});
