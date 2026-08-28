import { Router } from '@aws-lambda-powertools/event-handler/http';
import type { Context } from 'aws-lambda';
import type { X402Environment } from '../src/index.js';
import { createStripeX402 } from '../src/stripe.js';

const app = new Router<X402Environment>();

// Reads STRIPE_SECRET_KEY, STRIPE_DEPOSIT_ADDRESS, CDP_API_KEY_ID, and
// CDP_API_KEY_SECRET from the environment. Payments settle on Base mainnet
// through the Coinbase facilitator into your Stripe deposit address, and each
// settled payment is recorded as a Stripe PaymentIntent.
const x402 = createStripeX402({ enableMetrics: true });

app.post(
  '/paid',
  [x402.paid({ price: '$0.01', description: 'Data retrieval endpoint' })],
  async () => ({ foo: 'bar' })
);

export const handler = (event: unknown, context: Context) => app.resolve(event, context);
