import type { HTTPAdapter } from '@x402/core/server';

/**
 * Bridges the web-standard Request exposed by Powertools Event Handler
 * to x402's framework-agnostic HTTPAdapter.
 */
export class PowertoolsAdapter implements HTTPAdapter {
  constructor(private readonly request: Request) {}

  getHeader(name: string): string | undefined {
    return this.request.headers.get(name) ?? undefined;
  }

  getMethod(): string {
    return this.request.method;
  }

  getPath(): string {
    return new URL(this.request.url).pathname;
  }

  getUrl(): string {
    return this.request.url;
  }

  getAcceptHeader(): string {
    return this.request.headers.get('accept') ?? '';
  }

  getUserAgent(): string {
    return this.request.headers.get('user-agent') ?? '';
  }

  getQueryParams(): Record<string, string | string[]> {
    const params = new URL(this.request.url).searchParams;
    const result: Record<string, string | string[]> = {};

    for (const key of new Set(params.keys())) {
      const values = params.getAll(key);
      result[key] = values.length === 1 ? values[0] : values;
    }

    return result;
  }

  getQueryParam(name: string): string | string[] | undefined {
    const values = new URL(this.request.url).searchParams.getAll(name);
    if (values.length === 0) return undefined;
    return values.length === 1 ? values[0] : values;
  }

  async getBody(): Promise<unknown> {
    try {
      return await this.request.clone().json();
    } catch {
      return undefined;
    }
  }
}
