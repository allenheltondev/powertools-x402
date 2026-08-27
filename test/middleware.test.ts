import { Router } from '@aws-lambda-powertools/event-handler/http';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics } from '@aws-lambda-powertools/metrics';
import type { APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { Network } from '@x402/core/types';
import { registerExactEvmScheme as registerEvmClientScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { createX402, type X402Environment } from '../src/index.js';

const network: Network = 'eip155:84532';
const payTo = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const account = privateKeyToAccount(generatePrivateKey());

const lambdaContext = {} as Context;

const stubFacilitator = () => ({
  getSupported: vi.fn(async () => ({
    kinds: [{ x402Version: 2, scheme: 'exact', network }],
    extensions: [],
    signers: {},
  })),
  verify: vi.fn(async () => ({ isValid: true, payer: account.address })),
  settle: vi.fn(async () => ({
    success: true,
    transaction: '0xtransactionhash',
    network,
    payer: account.address,
  })),
});

const apiGatewayEvent = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
) => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: path,
  rawQueryString: '',
  headers: { host: 'api.example.com', 'content-type': 'application/json', ...headers },
  requestContext: {
    accountId: '123456789012',
    apiId: 'api-id',
    domainName: 'api.example.com',
    http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
    requestId: 'request-id',
    stage: '$default',
  },
  body,
  isBase64Encoded: false,
});

const payer = new x402HTTPClient(registerEvmClientScheme(new x402Client(), { signer: account }));

const payFor = async (res: APIGatewayProxyStructuredResultV2) => {
  const paymentRequired = payer.getPaymentRequiredResponse(
    (name: string) => res.headers?.[name.toLowerCase()] as string | undefined
  );
  const payload = await payer.createPaymentPayload(paymentRequired);
  return payer.encodePaymentSignatureHeader(payload) as Record<string, string>;
};

describe('x402 paid route middleware', () => {
  const setup = (options: Partial<Parameters<typeof createX402>[0]> = {}) => {
    const facilitator = stubFacilitator();
    const x402 = createX402({ facilitator, network, payTo, ...options });
    const app = new Router<X402Environment>();

    app.get('/free', async () => ({ status: 'ok' }));
    app.post('/paid', [x402.paid({ price: '$0.01', description: 'A paid thing' })], async (reqCtx) => ({
      payment: reqCtx.get('payment'),
    }));

    return { app, facilitator, x402 };
  };

  it('leaves unpaid routes alone', async () => {
    const { app, facilitator } = setup();

    const res = await app.resolve(apiGatewayEvent('GET', '/free'), lambdaContext);

    expect(res.statusCode).toBe(200);
    expect(facilitator.getSupported).not.toHaveBeenCalled();
  });

  it('returns 402 with payment requirements when no payment is attached', async () => {
    const { app, facilitator } = setup();

    const res = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);

    expect(res.statusCode).toBe(402);
    expect(res.headers?.['payment-required']).toBeDefined();
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('runs the handler and settles a valid payment', async () => {
    const { app, facilitator } = setup();

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(
      apiGatewayEvent('POST', '/paid', paymentHeaders),
      lambdaContext
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string).payment).toMatchObject({
      network,
      scheme: 'exact',
      amount: '10000',
      payer: account.address,
    });
    expect(res.headers?.['payment-response']).toBeDefined();
    expect(res.headers?.['cache-control']).toContain('private');
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid payment without running the handler', async () => {
    const { app, facilitator } = setup();
    facilitator.verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: 'insufficient_funds',
    } as never);

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(
      apiGatewayEvent('POST', '/paid', paymentHeaders),
      lambdaContext
    );

    expect(res.statusCode).toBe(402);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('cancels instead of settling when the handler throws', async () => {
    const facilitator = stubFacilitator();
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post('/explode', [x402.paid({ price: '$0.01' })], async () => {
      throw new Error('boom');
    });

    const challenge = await app.resolve(apiGatewayEvent('POST', '/explode'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(
      apiGatewayEvent('POST', '/explode', paymentHeaders),
      lambdaContext
    );

    expect(res.statusCode).toBe(500);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('cancels instead of settling when the handler returns an error status', async () => {
    const facilitator = stubFacilitator();
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post('/reject', [x402.paid({ price: '$0.01' })], async () =>
      Response.json({ error: 'bad input' }, { status: 400 })
    );

    const challenge = await app.resolve(apiGatewayEvent('POST', '/reject'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(
      apiGatewayEvent('POST', '/reject', paymentHeaders),
      lambdaContext
    );

    expect(res.statusCode).toBe(400);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it('returns a settlement failure without leaking handler headers', async () => {
    const facilitator = stubFacilitator();
    facilitator.settle.mockResolvedValue({
      success: false,
      errorReason: 'settle_failed',
      transaction: '',
      network,
    } as never);
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post('/paid', [x402.paid({ price: '$0.01' })], async () =>
      Response.json({ ok: true }, { headers: { etag: '"abc123"' } })
    );

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(
      apiGatewayEvent('POST', '/paid', paymentHeaders),
      lambdaContext
    );

    expect(res.statusCode).toBe(402);
    expect(res.headers?.etag).toBeUndefined();
  });

  it('fetches facilitator support once across paid routes', async () => {
    const facilitator = stubFacilitator();
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post('/one', [x402.paid({ price: '$0.01' })], async () => ({ ok: 1 }));
    app.post('/two', [x402.paid({ price: '$0.02' })], async () => ({ ok: 2 }));

    await app.resolve(apiGatewayEvent('POST', '/one'), lambdaContext);
    await app.resolve(apiGatewayEvent('POST', '/two'), lambdaContext);

    expect(facilitator.getSupported).toHaveBeenCalledTimes(1);
  });

  it('requires a price or accepts configuration', () => {
    const { x402 } = setup();
    expect(() => x402.paid({})).toThrow('price or an accepts');
  });

  it('recovers when the facilitator is down at cold start', async () => {
    const facilitator = stubFacilitator();
    facilitator.getSupported.mockRejectedValueOnce(new Error('facilitator unreachable'));
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post('/paid', [x402.paid({ price: '$0.01' })], async () => ({ ok: true }));

    const failed = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const recovered = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);

    expect(failed.statusCode).toBe(500);
    expect(recovered.statusCode).toBe(402);
    expect(facilitator.getSupported).toHaveBeenCalledTimes(2);
  });

  it('grants free access through onProtectedRequest', async () => {
    const facilitator = stubFacilitator();
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post(
      '/paid',
      [
        x402.paid({
          price: '$0.01',
          onProtectedRequest: async (ctx) => {
            if (ctx.adapter.getHeader('x-api-key') === 'trusted') return { grantAccess: true };
          },
        }),
      ],
      async () => ({ ok: true })
    );

    const free = await app.resolve(
      apiGatewayEvent('POST', '/paid', { 'x-api-key': 'trusted' }),
      lambdaContext
    );
    const paidOnly = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);

    expect(free.statusCode).toBe(200);
    expect(paidOnly.statusCode).toBe(402);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });

  it('offers every option from an accepts array in the 402 challenge', async () => {
    const facilitator = stubFacilitator();
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post(
      '/paid',
      [
        x402.paid({
          accepts: [
            { scheme: 'exact', network, payTo, price: '$0.01' },
            { scheme: 'exact', network, payTo, price: '$1.00' },
          ],
        }),
      ],
      async () => ({ ok: true })
    );

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentRequired = payer.getPaymentRequiredResponse(
      (name: string) => challenge.headers?.[name.toLowerCase()] as string | undefined
    );

    expect(challenge.statusCode).toBe(402);
    expect(paymentRequired.accepts).toHaveLength(2);
    expect(paymentRequired.accepts.map((a) => a.amount)).toEqual(['10000', '1000000']);
  });

  it('returns a custom unpaid response body', async () => {
    const facilitator = stubFacilitator();
    const x402 = createX402({ facilitator, network, payTo });
    const app = new Router<X402Environment>();
    app.post(
      '/paid',
      [
        x402.paid({
          price: '$0.01',
          unpaidResponseBody: async () => ({
            contentType: 'application/json',
            body: { preview: 'first 10 words free' },
          }),
        }),
      ],
      async () => ({ ok: true })
    );

    const res = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);

    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body as string)).toEqual({ preview: 'first 10 words free' });
  });

  it('emits metrics through the provided sink', async () => {
    const metrics = { addMetric: vi.fn() };
    const { app } = setup({ enableMetrics: true, metrics });

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    await app.resolve(apiGatewayEvent('POST', '/paid', paymentHeaders), lambdaContext);

    const names = metrics.addMetric.mock.calls.map(([name]) => name);
    expect(names).toContain('PaymentRequired');
    expect(names).toContain('PaymentVerified');
    expect(names).toContain('PaymentSettled');
  });

  it('emits EMF immediately through real Powertools Logger and Metrics instances', async () => {
    const metrics = new Metrics({ namespace: 'PaidApi', serviceName: 'test' });
    const logger = new Logger({ logLevel: 'SILENT' });
    const { app } = setup({ enableMetrics: true, metrics, logger });

    const writes: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    await app.resolve(apiGatewayEvent('POST', '/paid', paymentHeaders), lambdaContext);

    stdout.mockRestore();

    // Each metric arrives as its own EMF document, with no flush required.
    const emfDocs = writes
      .filter((line) => line.includes('_aws'))
      .map((line) => JSON.parse(line));
    const names = emfDocs.flatMap((doc) => doc._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name));

    expect(names).toEqual(['PaymentRequired', 'PaymentVerified', 'PaymentSettled']);
    for (const doc of emfDocs) {
      expect(doc._aws.CloudWatchMetrics[0].Namespace).toBe('PaidApi');
      expect(doc.service).toBe('test');
    }
    expect(emfDocs.at(-1).PaymentSettled).toBe(1);
  });

  it('emits nothing when metrics are not enabled, even with a sink', async () => {
    const metrics = { addMetric: vi.fn() };
    const { app } = setup({ metrics });

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    await app.resolve(apiGatewayEvent('POST', '/paid', paymentHeaders), lambdaContext);

    expect(metrics.addMetric).not.toHaveBeenCalled();
  });

  it('creates its own Metrics instance when enabled without a sink', async () => {
    const { app } = setup({ enableMetrics: true });

    const writes: string[] = [];
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);

    await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);

    stdout.mockRestore();

    const emfDocs = writes.filter((line) => line.includes('_aws')).map((line) => JSON.parse(line));
    expect(emfDocs).toHaveLength(1);
    expect(emfDocs[0]._aws.CloudWatchMetrics[0].Namespace).toBe('x402');
    expect(emfDocs[0].PaymentRequired).toBe(1);
  });

  it('counts a rejected payment as PaymentRejected, not PaymentRequired', async () => {
    const metrics = { addMetric: vi.fn() };
    const { app, facilitator } = setup({ enableMetrics: true, metrics });
    facilitator.verify.mockResolvedValue({ isValid: false, invalidReason: 'insufficient_funds' } as never);

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    metrics.addMetric.mockClear();
    const paymentHeaders = await payFor(challenge);
    await app.resolve(apiGatewayEvent('POST', '/paid', paymentHeaders), lambdaContext);

    const names = metrics.addMetric.mock.calls.map(([name]) => name);
    expect(names).toEqual(['PaymentRejected']);
  });
});
