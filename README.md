# powertools-x402

Paid API routes for [AWS Lambda Powertools Event Handler](https://docs.powertools.aws.dev/lambda/typescript/latest/features/event-handler/api-gateway/) using the [x402 payment protocol](https://x402.org).

## Install

```bash
npm install powertools-x402
```

Requires Node 18+. `@aws-lambda-powertools/event-handler` is a peer dependency, so npm will grab it automatically if your app doesn't already have it.

## What it does

`x402.paid()` is route middleware that turns any route into a paid endpoint. The route owns the price. Your handler stays pure business logic.

- No payment attached? The caller gets a 402 with signed payment requirements
- Payment attached? It gets verified with a facilitator before your handler runs
- Settlement happens after your handler succeeds. If it throws or returns an error status, the caller is never charged
- Verified payment details (payer, amount, network) are available in the request store

One contract to understand before you ship: verify happens before your handler, settlement happens after. That's the right fit for work that can safely run before the money moves, like inference, generation, and data retrieval. It is not a transaction around your business logic. If your handler performs an irreversible side effect and settlement fails afterward, the work already happened. Keep that kind of work reversible or reconcilable, or handle it with your own orchestration.

## Usage

### Charge for a route

```ts
import { Router } from '@aws-lambda-powertools/event-handler/http';
import type { Context } from 'aws-lambda';
import { createX402, type X402Environment } from 'powertools-x402';

const app = new Router<X402Environment>();

const x402 = createX402({
  facilitator: 'https://x402.org/facilitator',
  network: 'eip155:84532', // Base Sepolia
  payTo: process.env.PAY_TO!,
});

app.get('/health', async () => ({ status: 'ok' }));

app.post(
  '/summarize',
  [x402.paid({ price: '$0.01', description: 'Summarize some text' })],
  async (reqCtx) => {
    const { text } = (await reqCtx.req.json()) as { text: string };
    return { summary: text.slice(0, 80) };
  }
);

export const handler = (event: unknown, context: Context) => app.resolve(event, context);
```

Dollar prices settle in USDC on the route's network. `'$0.01'` on Base Sepolia charges 0.01 USDC.

### Read payment details in the handler

```ts
app.post('/generate', [x402.paid({ price: '$0.05' })], async (reqCtx) => {
  const payment = reqCtx.get('payment');
  // { network: 'eip155:84532', scheme: 'exact', asset: '0x...', amount: '50000', payer: '0x...' }
  return { result: 'expensive thing', paidBy: payment?.payer };
});
```

### Emit CloudWatch metrics

```ts
const x402 = createX402({
  facilitator: 'https://x402.org/facilitator',
  network: 'eip155:84532',
  payTo: process.env.PAY_TO!,
  enableMetrics: true, // defaults to false
  logger: new Logger(), // optional, any Powertools Logger works
});
```

This emits `PaymentRequired`, `PaymentRejected`, `PaymentVerified`, `PaymentSettled`, `PaymentCancelled`, and `SettlementFailed` counts under the `x402` namespace. Metrics publish immediately, so there's no `publishStoredMetrics()` call to remember. Pass your own `metrics` instance if you want a different namespace.

### Settle on mainnet with the Coinbase facilitator

The free `x402.org` facilitator is testnet only. Mainnet payments settle through the [Coinbase Developer Platform](https://portal.cdp.coinbase.com/) facilitator:

```bash
npm install @coinbase/x402
```

```ts
import { coinbaseFacilitator } from 'powertools-x402/coinbase';

const x402 = createX402({
  facilitator: coinbaseFacilitator(), // reads CDP_API_KEY_ID and CDP_API_KEY_SECRET
  network: 'eip155:8453', // Base mainnet
  payTo: process.env.PAY_TO!,
});
```

Using a different facilitator? Pass `{ url, createAuthHeaders }` straight through the `facilitator` option.

### Settle into your Stripe balance

Stripe supports x402 through [machine payments](https://docs.stripe.com/payments/machine/x402). Payments settle through the Coinbase facilitator into a Stripe crypto deposit address, and each settled payment is recorded as a Stripe PaymentIntent. Funds land in your Stripe balance next to your card payments.

```bash
npm install stripe @coinbase/x402
```

```ts
import { createStripeX402 } from 'powertools-x402/stripe';

// Reads STRIPE_SECRET_KEY, STRIPE_DEPOSIT_ADDRESS, CDP_API_KEY_ID, and CDP_API_KEY_SECRET
const x402 = createStripeX402();

app.post('/paid', [x402.paid({ price: '$0.01' })], async () => ({ foo: 'bar' }));
```

Prefer explicit config? Pass `depositAddress`, `stripeSecretKey` (or your own `stripe` client), and `cdpApiKeyId`/`cdpApiKeySecret` directly. Every other `createX402` option works here too.

A couple things to know:

- Create your deposit address once with `POST /v1/crypto/deposit_addresses` and store it. Keep that call off your request path.
- This uses Stripe's `2026-05-27.preview` API version, and you'll need the Stablecoins and Crypto payment method approved on your Stripe account.

### Accept multiple payment options on one route

```ts
x402.paid({
  accepts: [
    { scheme: 'exact', network: 'eip155:8453', payTo: evmAddress, price: '$0.05' },
    { scheme: 'exact', network: 'eip155:84532', payTo: evmAddress, price: '$0.01' },
  ],
});
```

Want to take payments on non-EVM networks? Register additional schemes with the `schemes` option on `createX402`.

### Price in a specific token

Dollar strings are shorthand for USDC. To pin the exact asset yourself, pass atomic units and the token address:

```ts
x402.paid({
  price: {
    amount: '10000', // atomic units, USDC has 6 decimals
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
    extra: { name: 'USDC', version: '2' }, // EIP-712 domain the payer signs against
  },
});
```

The same shape works for any EIP-3009 token. Set `extra` to the token's EIP-712 domain.

### Let some callers through free

```ts
x402.paid({
  price: '$0.01',
  onProtectedRequest: async (ctx) => {
    if (ctx.adapter.getHeader('x-api-key') === trustedKey) return { grantAccess: true };
  },
});
```

### Customize the 402 response

```ts
x402.paid({
  price: '$0.01',
  resource: 'https://api.example.com/summarize', // canonical URL behind custom domains
  unpaidResponseBody: async () => ({
    contentType: 'application/json',
    body: { preview: 'The first 10 words are free...' },
  }),
});
```

### Test your routes without a network

Import from `powertools-x402/testing` and your tests never touch the network. `stubFacilitator()` approves every payment, and `testPayer()` signs real payments with a throwaway account so you can test the paid path end to end:

```ts
import { stubFacilitator, testPayer } from 'powertools-x402/testing';

const facilitator = stubFacilitator(); // defaults to Base Sepolia
const x402 = createX402({
  facilitator,
  network: 'eip155:84532',
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
});

// 402 challenge, then pay it and assert on your handler's behavior
const payer = testPayer();
const challenge = await app.resolve(event('POST', '/paid'), context);
const paid = await app.resolve(event('POST', '/paid', await payer.payFor(challenge)), context);
```

Spy on `facilitator.verify` or `facilitator.settle` to assert calls or force failures. `payFor` also accepts fetch `Response` objects. And if you'd rather roll your own facilitator stub, it's any object with `verify`, `settle`, and `getSupported`.

### Pay for a request (client side)

In the paying app, install `@x402/core`, `@x402/evm`, and `viem`:

```ts
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const client = new x402HTTPClient(
  registerExactEvmScheme(new x402Client(), { signer: privateKeyToAccount(privateKey) })
);

// 1. Call without payment -> 402 with a PAYMENT-REQUIRED header
const challenge = await fetch(url, { method: 'POST', body });

// 2. Sign a payment for one of the offered options
const paymentRequired = client.getPaymentRequiredResponse((name) => challenge.headers.get(name));
const payment = await client.createPaymentPayload(paymentRequired);

// 3. Retry with the PAYMENT-SIGNATURE header -> 200 + settlement receipt
const paid = await fetch(url, { method: 'POST', headers: client.encodePaymentSignatureHeader(payment), body });
const receipt = client.getPaymentSettleResponse((name) => paid.headers.get(name));
```

Need testnet USDC? Grab some from the [Circle faucet](https://faucet.circle.com/).

## Examples

- [example/handler.ts](example/handler.ts) - lambdalith with free and paid routes
- [example/client.ts](example/client.ts) - paying client, step by step
- [example/stripe.ts](example/stripe.ts) - settle x402 payments into your Stripe balance
- [example/template.yaml](example/template.yaml) - SAM deploy (esbuild, ESM, HTTP API)

## License

MIT
