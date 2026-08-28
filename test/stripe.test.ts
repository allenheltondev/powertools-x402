import { Router } from '@aws-lambda-powertools/event-handler/http';
import type { APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { Network } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { coinbaseFacilitator } from '../src/coinbase.js';
import type { X402Environment } from '../src/index.js';
import { createStripeX402 } from '../src/stripe.js';

const network: Network = 'eip155:8453';
const depositAddress = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
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

const fakeStripe = () => ({
  paymentIntents: {
    create: vi.fn(
      async (params: Record<string, any>, options: { idempotencyKey: string }) => ({ id: 'pi_123' })
    ),
  },
});

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

const payer = new x402HTTPClient(registerExactEvmScheme(new x402Client(), { signer: account }));

const payFor = async (res: APIGatewayProxyStructuredResultV2) => {
  const paymentRequired = payer.getPaymentRequiredResponse(
    (name: string) => res.headers?.[name.toLowerCase()] as string | undefined
  );
  const payload = await payer.createPaymentPayload(paymentRequired);
  return payer.encodePaymentSignatureHeader(payload) as Record<string, string>;
};

describe('createStripeX402', () => {
  const setup = () => {
    const facilitator = stubFacilitator();
    const stripe = fakeStripe();
    const x402 = createStripeX402({ facilitator, stripe, depositAddress });
    const app = new Router<X402Environment>();
    app.post('/paid', [x402.paid({ price: '$0.01' })], async () => ({ foo: 'bar' }));
    return { app, facilitator, stripe };
  };

  it('records a settled payment as a Stripe PaymentIntent', async () => {
    const { app, stripe } = setup();

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(apiGatewayEvent('POST', '/paid', paymentHeaders), lambdaContext);

    expect(res.statusCode).toBe(200);
    expect(stripe.paymentIntents.create).toHaveBeenCalledTimes(1);
    const [params, requestOptions] = stripe.paymentIntents.create.mock.calls[0];
    expect(params).toMatchObject({ amount: 1, currency: 'usd', confirm: true });
    expect(params.payment_method_options.crypto.transaction_verification_options).toEqual({
      network: 'base',
      transaction_hash: '0xtransactionhash',
    });
    expect(requestOptions).toEqual({ idempotencyKey: '0xtransactionhash' });
  });

  it('sends payments to the Stripe deposit address', async () => {
    const { app } = setup();

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentRequired = payer.getPaymentRequiredResponse(
      (name: string) => challenge.headers?.[name.toLowerCase()] as string | undefined
    );

    expect(paymentRequired.accepts[0].payTo.toLowerCase()).toBe(depositAddress.toLowerCase());
  });

  it('still returns the paid response when Stripe recording fails', async () => {
    const facilitator = stubFacilitator();
    const stripe = fakeStripe();
    stripe.paymentIntents.create.mockRejectedValue(new Error('stripe is down'));
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const x402 = createStripeX402({ facilitator, stripe, depositAddress, logger });
    const app = new Router<X402Environment>();
    app.post('/paid', [x402.paid({ price: '$0.01' })], async () => ({ foo: 'bar' }));

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(apiGatewayEvent('POST', '/paid', paymentHeaders), lambdaContext);

    // The payment settled on-chain; a recording failure must not fail the request
    expect(res.statusCode).toBe(200);
    expect(res.headers?.['payment-response']).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith(
      'stripe payment intent recording failed',
      expect.objectContaining({ transaction: '0xtransactionhash' })
    );
  });

  it('does not create a PaymentIntent when settlement fails', async () => {
    const { app, facilitator, stripe } = setup();
    facilitator.settle.mockResolvedValue({
      success: false,
      errorReason: 'settle_failed',
      transaction: '',
      network,
    } as never);

    const challenge = await app.resolve(apiGatewayEvent('POST', '/paid'), lambdaContext);
    const paymentHeaders = await payFor(challenge);
    const res = await app.resolve(apiGatewayEvent('POST', '/paid', paymentHeaders), lambdaContext);

    expect(res.statusCode).toBe(402);
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('requires a deposit address', () => {
    delete process.env.STRIPE_DEPOSIT_ADDRESS;
    expect(() => createStripeX402({ stripe: fakeStripe() })).toThrow('depositAddress');
  });

  it('requires Stripe credentials', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => createStripeX402({ depositAddress })).toThrow('stripeSecretKey');
  });

  it('constructs a real Stripe client from a secret key', () => {
    const x402 = createStripeX402({
      facilitator: stubFacilitator(),
      stripeSecretKey: 'sk_test_123',
      depositAddress,
    });
    expect(typeof x402.paid).toBe('function');
  });
});

describe('coinbaseFacilitator', () => {
  it('returns a facilitator config pointing at the CDP endpoint', () => {
    const config = coinbaseFacilitator('key-id', 'key-secret');
    expect(config.url).toContain('cdp.coinbase.com');
    expect(typeof config.createAuthHeaders).toBe('function');
  });
});
