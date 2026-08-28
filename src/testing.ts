import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network, SettleResponse, VerifyResponse } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const TEST_PAYER_ADDRESS = '0x0000000000000000000000000000000000C0FFEE';
export const TEST_TRANSACTION_HASH = `0x${'ab'.repeat(32)}`;

export interface StubFacilitatorOptions {
  network?: Network | Network[];
  payer?: string;
  verify?: Partial<VerifyResponse>;
  settle?: Partial<SettleResponse>;
}

/**
 * In-memory facilitator that approves every payment. Spy on its methods or
 * override verify/settle responses to exercise failure paths.
 */
export function stubFacilitator(options: StubFacilitatorOptions = {}): FacilitatorClient {
  const networks = [options.network ?? 'eip155:84532'].flat() as Network[];
  const payer = options.payer ?? TEST_PAYER_ADDRESS;

  return {
    async getSupported() {
      return {
        kinds: networks.map((network) => ({ x402Version: 2, scheme: 'exact', network })),
        extensions: [],
        signers: {},
      };
    },
    async verify() {
      return { isValid: true, payer, ...options.verify };
    },
    async settle() {
      return {
        success: true,
        transaction: TEST_TRANSACTION_HASH,
        network: networks[0],
        payer,
        ...options.settle,
      };
    },
  };
}

type ChallengeLike = Response | { headers?: Record<string, unknown> };

const getHeaderFrom = (challenge: ChallengeLike) => (name: string): string | undefined => {
  if (challenge.headers instanceof Headers) return challenge.headers.get(name) ?? undefined;
  const value = challenge.headers?.[name.toLowerCase()];
  return value === undefined ? undefined : String(value);
};

/**
 * A payment client backed by a throwaway account. Feed it a 402 response and
 * it returns the headers that make the retried request a valid paid request.
 */
export function testPayer(privateKey?: `0x${string}`) {
  const account = privateKeyToAccount(privateKey ?? generatePrivateKey());
  const client = new x402HTTPClient(
    registerExactEvmScheme(new x402Client(), { signer: account })
  );

  return {
    address: account.address,
    async payFor(challenge: ChallengeLike): Promise<Record<string, string>> {
      const paymentRequired = client.getPaymentRequiredResponse(getHeaderFrom(challenge));
      const payload = await client.createPaymentPayload(paymentRequired);
      return client.encodePaymentSignatureHeader(payload);
    },
  };
}
