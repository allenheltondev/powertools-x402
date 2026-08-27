# powertools-x402

Paid API routes for [AWS Lambda Powertools Event Handler](https://docs.powertools.aws.dev/lambda/typescript/latest/features/event-handler/api-gateway/) using the [x402 payment protocol](https://x402.org).

## Install

```bash
npm install powertools-x402 @aws-lambda-powertools/event-handler @aws-lambda-powertools/metrics @x402/core @x402/evm
```

Requires Node 18+.

## What it does

`x402.paid()` is route middleware that turns any route into a paid endpoint. The route owns the price; the handler stays pure business logic.

- No payment attached → 402 response with signed payment requirements
- Payment attached → verified with a facilitator before your handler runs
- Settlement happens after your handler succeeds — a handler that throws or returns an error status is never charged
- Verified payment details (payer, amount, network) are available in the request store

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

Emits `PaymentRequired`, `PaymentRejected`, `PaymentVerified`, `PaymentSettled`, `PaymentCancelled`, and `SettlementFailed` counts under the `x402` namespace. Each metric is published immediately — no `publishStoredMetrics()` call needed. Pass your own `metrics` instance to change the namespace.

### Use an authenticated facilitator

```ts
const x402 = createX402({
  facilitator: {
    url: 'https://facilitator.example.com',
    createAuthHeaders: async () => {
      const headers = { Authorization: `Bearer ${token}` };
      return { verify: headers, settle: headers, supported: headers };
    },
  },
  network: 'eip155:8453', // Base mainnet
  payTo: process.env.PAY_TO!,
});
```

### Accept multiple payment options on one route

```ts
x402.paid({
  accepts: [
    { scheme: 'exact', network: 'eip155:8453', payTo: evmAddress, price: '$0.05' },
    { scheme: 'exact', network: 'eip155:84532', payTo: evmAddress, price: '$0.01' },
  ],
});
```

Register additional schemes (e.g. non-EVM networks) with the `schemes` option on `createX402`.

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

`facilitator` accepts any object with `verify`/`settle`/`getSupported`:

```ts
const facilitator = {
  getSupported: async () => ({
    kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:84532' }],
    extensions: [],
    signers: {},
  }),
  verify: async () => ({ isValid: true, payer: '0xPayer' }),
  settle: async () => ({ success: true, transaction: '0xTx', network: 'eip155:84532' }),
};

const x402 = createX402({ facilitator, network: 'eip155:84532', payTo: '0xYou' });
```

Drive your router with API Gateway events through `app.resolve(event, context)` — see [test/middleware.test.ts](test/middleware.test.ts) for full round trips, including client-side payment signing.

### Pay for a request (client side)

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

Testnet USDC: [Circle faucet](https://faucet.circle.com/).

## Examples

- [example/handler.ts](example/handler.ts) — lambdalith with free and paid routes
- [example/client.ts](example/client.ts) — paying client, step by step
- [example/template.yaml](example/template.yaml) — SAM deploy (esbuild, ESM, HTTP API)

## License

MIT
