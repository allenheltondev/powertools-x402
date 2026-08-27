import type { FacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';

/**
 * Memoizes getSupported() so every paid route on a cold start shares one
 * facilitator round trip instead of re-fetching per route.
 */
export class CachingFacilitatorClient implements FacilitatorClient {
  #supported: Promise<SupportedResponse> | undefined;

  constructor(private readonly client: FacilitatorClient) {}

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.client.verify(payload, requirements);
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.client.settle(payload, requirements);
  }

  getSupported(): Promise<SupportedResponse> {
    this.#supported ??= this.client.getSupported().catch((error) => {
      this.#supported = undefined;
      throw error;
    });
    return this.#supported;
  }
}
