import { Router } from '@aws-lambda-powertools/event-handler/http';
import type { Context } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { createX402, type X402Environment } from '../src/index.js';
import { stubFacilitator, testPayer, TEST_TRANSACTION_HASH } from '../src/testing.js';

const lambdaContext = {} as Context;

const apiGatewayEvent = (method: string, path: string, headers: Record<string, string> = {}) => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: path,
  rawQueryString: '',
  headers: { host: 'api.example.com', ...headers },
  requestContext: {
    accountId: '123456789012',
    apiId: 'api-id',
    domainName: 'api.example.com',
    http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'vitest' },
    requestId: 'request-id',
    stage: '$default',
  },
  isBase64Encoded: false,
});

describe('powertools-x402/testing', () => {
  const buildApp = (facilitator = stubFacilitator()) => {
    const x402 = createX402({
      facilitator,
      network: 'eip155:84532',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    });
    const app = new Router<X402Environment>();
    app.post('/paid', [x402.paid({ price: '$0.01' })], async (reqCtx) => ({
      payment: reqCtx.get('payment'),
    }));
    return app;
  };

  it('drives a full paid round trip with stubFacilitator and testPayer', async () => {
    const app = buildApp();
    const payer = testPayer();

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const res = await app.resolve(
      apiGatewayEvent('POST', '/paid', await payer.payFor(challenge)),
      lambdaContext
    );

    expect(challenge.statusCode).toBe(402);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string).payment.amount).toBe('10000');
    expect(res.headers?.['payment-response']).toBeDefined();
  });

  it('supports spying and per-call overrides on the stub', async () => {
    const facilitator = stubFacilitator();
    const settle = vi.spyOn(facilitator, 'settle');
    const verify = vi
      .spyOn(facilitator, 'verify')
      .mockResolvedValueOnce({ isValid: false, invalidReason: 'insufficient_funds' });
    const app = buildApp(facilitator);
    const payer = testPayer();

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const rejected = await app.resolve(
      apiGatewayEvent('POST', '/paid', await payer.payFor(challenge)),
      lambdaContext
    );

    expect(rejected.statusCode).toBe(402);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });

  it('configures the settle response through options', async () => {
    const facilitator = stubFacilitator({ settle: { transaction: '0xcustom' } });

    await expect(facilitator.settle({} as never, {} as never)).resolves.toMatchObject({
      success: true,
      transaction: '0xcustom',
    });
    await expect(stubFacilitator().settle({} as never, {} as never)).resolves.toMatchObject({
      transaction: TEST_TRANSACTION_HASH,
    });
  });

  it('reads challenges from fetch Response objects too', async () => {
    const app = buildApp();
    const payer = testPayer();

    const proxyResult = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const asFetchResponse = new Response('', {
      status: 402,
      headers: { 'payment-required': String(proxyResult.headers?.['payment-required']) },
    });

    const headers = await payer.payFor(asFetchResponse);
    expect(headers['PAYMENT-SIGNATURE']).toBeDefined();
  });
});
