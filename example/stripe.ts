import { Router } from '@aws-lambda-powertools/event-handler/http';
import { createFacilitatorConfig } from '@coinbase/x402';
import type { Context } from 'aws-lambda';
import Stripe from 'stripe';
import { createX402, type X402Environment } from '../src/index.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.preview' as Stripe.LatestApiVersion,
});

const app = new Router<X402Environment>();

const x402 = createX402({
  // Mainnet payments settle through the Coinbase Developer Platform facilitator
  facilitator: createFacilitatorConfig(
    process.env.CDP_API_KEY_ID!,
    process.env.CDP_API_KEY_SECRET!
  ),
  network: 'eip155:8453', // Base mainnet
  // A Stripe crypto deposit address, created once via POST /v1/crypto/deposit_addresses
  payTo: process.env.STRIPE_DEPOSIT_ADDRESS!,
  enableMetrics: true,
});

// Record each settled payment as a Stripe PaymentIntent so it lands in your
// Stripe balance and shows up in the Dashboard alongside card payments.
x402.resourceServer.onAfterSettle(async ({ result, requirements }) => {
  if (!result.success || !result.transaction) return;

  // requirements.amount is atomic USDC (6 decimals); Stripe wants cents
  const amountInCents = Math.round(Number(requirements.amount) / 10_000);
  if (amountInCents < 1) return;

  await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: 'usd',
      confirm: true,
      payment_method_data: { type: 'crypto' },
      payment_method_types: ['crypto'],
      payment_method_options: {
        // transaction_verification mode ships in the 2026-05-27.preview API
        // version and is not yet in stripe-node's stable types
        crypto: {
          mode: 'transaction_verification',
          transaction_verification_options: {
            network: 'base',
            transaction_hash: result.transaction,
          },
        } as Stripe.PaymentIntentCreateParams.PaymentMethodOptions.Crypto,
      },
    },
    { idempotencyKey: result.transaction }
  );
});

app.post(
  '/paid',
  [x402.paid({ price: '$0.01', description: 'Data retrieval endpoint' })],
  async () => ({ foo: 'bar' })
);

export const handler = (event: unknown, context: Context) => app.resolve(event, context);
