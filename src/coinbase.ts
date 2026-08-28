import { createFacilitatorConfig } from '@coinbase/x402';
import type { FacilitatorConfig } from '@x402/core/server';

/**
 * Coinbase Developer Platform facilitator for mainnet settlement.
 * Falls back to CDP_API_KEY_ID and CDP_API_KEY_SECRET when keys are omitted.
 */
export const coinbaseFacilitator = (
  apiKeyId?: string,
  apiKeySecret?: string
): FacilitatorConfig => createFacilitatorConfig(apiKeyId, apiKeySecret);
