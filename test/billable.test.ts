import { Router } from '@aws-lambda-powertools/event-handler/http';
import type { HandlerResponse } from '@aws-lambda-powertools/event-handler/types';
import type { Context } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  createX402,
  type BillablePredicate,
  type X402Environment,
} from '../src/index.js';
import { stubFacilitator, testPayer } from '../src/testing.js';

const network = 'eip155:84532';
const payTo = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
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

type SetupOptions = {
  billable?: BillablePredicate;
  handler?: () => Promise<HandlerResponse>;
  metrics?: { addMetric: ReturnType<typeof vi.fn> };
};

const setup = ({ billable, handler, metrics }: SetupOptions = {}) => {
  const facilitator = stubFacilitator();
  const settle = vi.spyOn(facilitator, 'settle');
  const x402 = createX402({
    facilitator,
    network,
    payTo,
    ...(metrics ? { enableMetrics: true, metrics } : {}),
  });
  const app = new Router<X402Environment>();
  app.post(
    '/answer',
    [x402.paid({ price: '$0.05', ...(billable ? { billable } : {}) })],
    handler ?? (async () => ({ answer: '42' }))
  );

  return { app, settle };
};

/** Runs the 402 challenge, then replays the request with a signed payment. */
const callPaid = async (app: Router<X402Environment>) => {
  const payer = testPayer();
  const challenge = await app.resolve(apiGatewayEvent('POST', '/answer'), lambdaContext);
  return app.resolve(
    apiGatewayEvent('POST', '/answer', await payer.payFor(challenge)),
    lambdaContext
  );
};

describe('billable predicate', () => {
  it('settles as before when no predicate is configured', async () => {
    const { app, settle } = setup();

    const res = await callPaid(app);

    expect(res.statusCode).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(res.headers?.['payment-response']).toBeDefined();
  });

  it('settles when the predicate returns true', async () => {
    const { app, settle } = setup({ billable: () => true });

    const res = await callPaid(app);

    expect(res.statusCode).toBe(200);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('skips settlement and returns the handler response when the predicate returns false', async () => {
    const seen: { body: unknown; payer?: string }[] = [];
    const { app, settle } = setup({
      handler: async () => ({ answer: null, reason: 'no match' }),
      billable: async (response, reqCtx) => {
        seen.push({ body: await response.json(), payer: reqCtx.get('payment')?.payer });
        return false;
      },
    });

    const res = await callPaid(app);

    expect(settle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ answer: null, reason: 'no match' });
    expect(res.headers?.['payment-response']).toBeUndefined();
    // The predicate sees the handler's body and the verified payment details.
    expect(seen).toEqual([{ body: { answer: null, reason: 'no match' }, payer: expect.any(String) }]);
  });

  it('treats an async predicate resolving false the same as the sync case', async () => {
    const { app, settle } = setup({
      billable: async () => {
        await Promise.resolve();
        return false;
      },
    });

    const res = await callPaid(app);

    expect(settle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ answer: '42' });
  });

  it('counts a skipped settlement apart from a cancelled payment', async () => {
    const metrics = { addMetric: vi.fn() };
    const { app } = setup({ billable: () => false, metrics });

    await callPaid(app);

    const names = metrics.addMetric.mock.calls.map(([name]) => name);
    expect(names).toContain('PaymentNotBillable');
    expect(names).not.toContain('PaymentCancelled');
    expect(names).not.toContain('PaymentSettled');
  });

  it('does not consult the predicate when the handler throws', async () => {
    const billable = vi.fn(() => true);
    const { app, settle } = setup({
      billable,
      handler: async () => {
        throw new Error('boom');
      },
    });

    const res = await callPaid(app);

    expect(res.statusCode).toBe(500);
    expect(billable).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('does not consult the predicate when the handler returns an error status', async () => {
    const billable = vi.fn(() => true);
    const { app, settle } = setup({
      billable,
      handler: async () => Response.json({ error: 'bad input' }, { status: 400 }),
    });

    const res = await callPaid(app);

    expect(res.statusCode).toBe(400);
    expect(billable).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it('treats a throwing predicate as not billable without failing the request', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const facilitator = stubFacilitator();
    const settle = vi.spyOn(facilitator, 'settle');
    const x402 = createX402({ facilitator, network, payTo, logger });
    const app = new Router<X402Environment>();
    app.post(
      '/answer',
      [
        x402.paid({
          price: '$0.05',
          billable: () => {
            throw new Error('predicate is broken');
          },
        }),
      ],
      async () => ({ answer: '42' })
    );

    const res = await callPaid(app);

    expect(settle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ answer: '42' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('billable'),
      expect.objectContaining({ path: '/answer' })
    );
  });

  it('treats a rejecting predicate as not billable', async () => {
    const { app, settle } = setup({
      billable: async () => {
        throw new Error('upstream lookup failed');
      },
    });

    const res = await callPaid(app);

    expect(settle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ answer: '42' });
  });
});

describe('billable on a flow that settles before the handler', () => {
  // Stock exact supports the upfront flow, selected off the accepts entry --
  // the same thing a user would write, and the reason this branch is reachable
  // without a custom scheme.
  const setupUpfront = (billable: BillablePredicate) => {
    const facilitator = stubFacilitator();
    const settle = vi.spyOn(facilitator, 'settle');
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const x402 = createX402({ facilitator, network, payTo, logger });
    const app = new Router<X402Environment>();
    app.post(
      '/answer',
      [
        x402.paid({
          accepts: {
            scheme: 'exact',
            network,
            payTo,
            price: '$0.05',
            extra: { paymentFlow: 'upfront' },
          },
          billable,
        }),
      ],
      async () => ({ answer: '42' })
    );
    return { app, settle, logger };
  };

  it('settles anyway and logs, rather than claiming a refund it never made', async () => {
    const { app, settle, logger } = setupUpfront(() => false);

    const res = await callPaid(app);

    expect(res.statusCode).toBe(200);
    // The money already moved before the handler ran, so the caller still gets
    // their receipt instead of a silently unsettled payment.
    expect(settle).toHaveBeenCalled();
    expect(res.headers?.['payment-response']).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('settles before the handler'),
      expect.objectContaining({ path: '/answer' })
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('not billed'),
      expect.anything()
    );
  });
});
