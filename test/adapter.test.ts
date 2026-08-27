import { describe, expect, it } from 'vitest';
import { PowertoolsAdapter } from '../src/adapter.js';

describe('PowertoolsAdapter', () => {
  const adapter = (url: string, init?: RequestInit) => new PowertoolsAdapter(new Request(url, init));

  it('exposes method, path, url, and headers', () => {
    const a = adapter('https://api.example.com/things?limit=5', {
      method: 'POST',
      headers: { accept: 'application/json', 'user-agent': 'vitest', 'x-custom': 'yes' },
    });

    expect(a.getMethod()).toBe('POST');
    expect(a.getPath()).toBe('/things');
    expect(a.getUrl()).toBe('https://api.example.com/things?limit=5');
    expect(a.getAcceptHeader()).toBe('application/json');
    expect(a.getUserAgent()).toBe('vitest');
    expect(a.getHeader('x-custom')).toBe('yes');
    expect(a.getHeader('missing')).toBeUndefined();
  });

  it('collapses single-value query params and keeps repeated ones as arrays', () => {
    const a = adapter('https://api.example.com/things?a=1&a=2&b=3');

    expect(a.getQueryParams()).toEqual({ a: ['1', '2'], b: '3' });
    expect(a.getQueryParam('a')).toEqual(['1', '2']);
    expect(a.getQueryParam('b')).toBe('3');
    expect(a.getQueryParam('missing')).toBeUndefined();
  });

  it('parses JSON bodies and returns undefined for anything else', async () => {
    const json = adapter('https://api.example.com/things', {
      method: 'POST',
      body: JSON.stringify({ x: 1 }),
    });
    const text = adapter('https://api.example.com/things', { method: 'POST', body: 'not json' });

    await expect(json.getBody()).resolves.toEqual({ x: 1 });
    await expect(text.getBody()).resolves.toBeUndefined();
  });
});
