import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const client = new x402HTTPClient(
  registerExactEvmScheme(new x402Client(), { signer: account })
);

const url = `${process.env.API_URL}/summarize`;
const body = JSON.stringify({ text: 'The quick brown fox jumps over the lazy dog.' });

const challenge = await fetch(url, { method: 'POST', body });
if (challenge.status !== 402) throw new Error(`Expected a 402 challenge, got ${challenge.status}`);

const paymentRequired = client.getPaymentRequiredResponse((name) => challenge.headers.get(name));
const payment = await client.createPaymentPayload(paymentRequired);

const paid = await fetch(url, {
  method: 'POST',
  headers: client.encodePaymentSignatureHeader(payment),
  body,
});

console.log(paid.status, await paid.json());
console.log('settlement:', client.getPaymentSettleResponse((name) => paid.headers.get(name)));
