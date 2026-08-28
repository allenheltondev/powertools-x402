import Stripe from 'stripe';
import type { Network } from '@x402/core/types';
import { coinbaseFacilitator } from './coinbase.js';
import { createX402, type CreateX402Options } from './index.js';

const BASE_MAINNET: Network = 'eip155:8453';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const STRIPE_PREVIEW_API_VERSION = '2026-05-27.preview';

export interface StripeClient {
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options: { idempotencyKey: string }
    ): Promise<unknown>;
  };
}

export interface StripeX402Options
  extends Omit<CreateX402Options, 'facilitator' | 'payTo' | 'network'> {
  depositAddress?: string;
  stripeSecretKey?: string;
  stripe?: StripeClient;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  facilitator?: CreateX402Options['facilitator'];
}

/**
 * x402 routes that settle into your Stripe balance: payments go to a Stripe
 * crypto deposit address via the Coinbase facilitator, and each settled
 * payment is recorded as a Stripe PaymentIntent (transaction_verification).
 *
 * Intentionally pinned to USDC on Base mainnet; the PaymentIntent recording
 * assumes that network and asset. A failed recording never fails the request:
 * the payment already settled on-chain, so the failure is logged with the
 * transaction hash for reconciliation instead.
 */
export function createStripeX402(options: StripeX402Options = {}) {
  const {
    depositAddress = process.env.STRIPE_DEPOSIT_ADDRESS,
    stripeSecretKey = process.env.STRIPE_SECRET_KEY,
    stripe,
    cdpApiKeyId,
    cdpApiKeySecret,
    facilitator,
    ...rest
  } = options;

  if (!depositAddress) {
    throw new Error(
      'createStripeX402 requires a depositAddress (or STRIPE_DEPOSIT_ADDRESS). Create one with POST /v1/crypto/deposit_addresses.'
    );
  }
  if (!stripe && !stripeSecretKey) {
    throw new Error('createStripeX402 requires a stripe client or stripeSecretKey (or STRIPE_SECRET_KEY).');
  }

  const stripeClient: StripeClient =
    stripe ??
    new Stripe(stripeSecretKey as string, {
      apiVersion: STRIPE_PREVIEW_API_VERSION as Stripe.LatestApiVersion,
    });

  const x402 = createX402({
    ...rest,
    network: BASE_MAINNET,
    facilitator: facilitator ?? coinbaseFacilitator(cdpApiKeyId, cdpApiKeySecret),
    payTo: depositAddress,
  });

  x402.resourceServer.onAfterSettle(async ({ result, requirements }) => {
    if (!result.success || !result.transaction) return;
    // The cents conversion below is only valid for USDC on Base
    if (requirements.network !== BASE_MAINNET) return;
    if (requirements.asset.toLowerCase() !== BASE_USDC.toLowerCase()) return;

    const amountInCents = Math.round(Number(requirements.amount) / 10_000);
    if (amountInCents < 1) return;

    try {
      await stripeClient.paymentIntents.create(
        {
          amount: amountInCents,
          currency: 'usd',
          confirm: true,
          payment_method_data: { type: 'crypto' },
          payment_method_types: ['crypto'],
          payment_method_options: {
            // transaction_verification ships in the 2026-05-27.preview API
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
    } catch (error) {
      // The payment already settled on-chain. Never fail the request over a
      // recording error; log the transaction hash so it can be reconciled.
      rest.logger?.error('stripe payment intent recording failed', {
        transaction: result.transaction,
        amountInCents,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return x402;
}
