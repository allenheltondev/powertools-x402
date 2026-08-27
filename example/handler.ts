import { Router } from '@aws-lambda-powertools/event-handler/http';
import type { Context } from 'aws-lambda';
import { createX402, type X402Environment } from '../src/index.js';

const app = new Router<X402Environment>();

const x402 = createX402({
  facilitator: 'https://x402.org/facilitator',
  network: 'eip155:84532', // Base Sepolia
  payTo: process.env.PAY_TO!,
  enableMetrics: true,
});

app.get('/health', async () => ({ status: 'ok' }));

app.post(
  '/summarize',
  [
    x402.paid({
      price: '$0.01',
      description: 'Summarize some text',
    }),
  ],
  async (reqCtx) => {
    const body = (await reqCtx.req.json()) as { text: string };
    const payment = reqCtx.get('payment');

    return {
      summary: body.text.slice(0, 80),
      paidBy: payment?.payer,
    };
  }
);

app.post(
  '/generate',
  [
    x402.paid({
      price: '$0.05',
      description: 'Generate an expensive thing',
    }),
  ],
  async () => ({ result: 'expensive thing' })
);

export const handler = (event: unknown, context: Context) =>
  app.resolve(event, context);
