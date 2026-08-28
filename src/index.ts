import type { Middleware } from '@aws-lambda-powertools/event-handler/types';
import { Metrics } from '@aws-lambda-powertools/metrics';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type FacilitatorConfig,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type PaywallConfig,
  type ProtectedRequestHook,
  type RouteConfig,
} from '@x402/core/server';
import type { PaymentOption } from '@x402/core/http';
import type { Network, Price } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { PowertoolsAdapter } from './adapter.js';
import { CachingFacilitatorClient } from './facilitator.js';

export interface X402Logger {
  debug(message: string, extra: Record<string, unknown>): void;
  warn(message: string, extra: Record<string, unknown>): void;
  error(message: string, extra: Record<string, unknown>): void;
}

export interface X402Metrics {
  addMetric(name: string, unit: 'Count', value: number): void;
  singleMetric?(): Pick<X402Metrics, 'addMetric'>;
}

export type SchemeRegistrar = (server: x402ResourceServer) => unknown;

export interface CreateX402Options {
  facilitator: string | FacilitatorConfig | FacilitatorClient;
  network: Network;
  payTo: string;
  schemes?: SchemeRegistrar[];
  paywall?: PaywallConfig;
  logger?: X402Logger;
  enableMetrics?: boolean;
  metrics?: X402Metrics;
}

export interface PaidRouteOptions extends Omit<RouteConfig, 'accepts'> {
  price?: Price;
  accepts?: PaymentOption | PaymentOption[];
  onProtectedRequest?: ProtectedRequestHook;
}

export type PaymentInfo = {
  network: Network;
  scheme: string;
  asset: string;
  amount: string;
  payer?: string;
};

export type X402Environment = {
  store: {
    request: {
      payment?: PaymentInfo;
    };
  };
};

const toFacilitatorClient = (facilitator: CreateX402Options['facilitator']): FacilitatorClient => {
  if (typeof facilitator === 'string') return new HTTPFacilitatorClient({ url: facilitator });
  if ('getSupported' in facilitator) return facilitator;
  return new HTTPFacilitatorClient(facilitator);
};

const toResponse = ({ status, headers, body, isHtml }: HTTPResponseInstructions): Response =>
  new Response(isHtml ? String(body ?? '') : JSON.stringify(body ?? {}), { status, headers });

export function createX402(options: CreateX402Options) {
  const facilitator = new CachingFacilitatorClient(toFacilitatorClient(options.facilitator));
  const resourceServer = new x402ResourceServer(facilitator);
  for (const register of options.schemes ?? [registerExactEvmScheme]) {
    register(resourceServer);
  }

  const { logger } = options;
  const metrics = options.enableMetrics
    ? options.metrics ?? new Metrics({ namespace: 'x402' })
    : undefined;
  // Prefer singleMetric() so each count is emitted immediately instead of
  // sitting in a buffer the caller would have to flush.
  const count = (name: string) =>
    metrics && (metrics.singleMetric?.() ?? metrics).addMetric(name, 'Count', 1);

  const payers = new WeakMap<object, string>();
  resourceServer.onAfterVerify(async ({ paymentPayload, result }) => {
    if (result.payer) payers.set(paymentPayload, result.payer);
  });

  /**
   * With the default exact payment flow, verifies payment before the handler
   * and settles after it succeeds; handlers that throw or respond with an
   * error status are not settled. Best suited to work that can safely run
   * before settlement (inference, generation, retrieval): if the handler
   * performs irreversible side effects and settlement then fails, the work
   * has already happened.
   */
  function paid(route: PaidRouteOptions): Middleware<X402Environment> {
    const { price, accepts, onProtectedRequest, ...routeConfig } = route;
    if (accepts === undefined && price === undefined) {
      throw new Error('paid() requires a price or an accepts configuration');
    }

    const httpServer = new x402HTTPResourceServer(resourceServer, {
      ...routeConfig,
      mimeType: routeConfig.mimeType ?? 'application/json',
      accepts: accepts ?? {
        scheme: 'exact',
        network: options.network,
        payTo: options.payTo,
        price: price as Price,
      },
    });
    if (onProtectedRequest) httpServer.onProtectedRequest(onProtectedRequest);

    let ready: Promise<void> | undefined;
    const initialize = () =>
      (ready ??= httpServer.initialize().catch((error) => {
        ready = undefined;
        throw error;
      }));

    return async ({ reqCtx, next }) => {
      await initialize();

      const adapter = new PowertoolsAdapter(reqCtx.req);
      const context: HTTPRequestContext = {
        adapter,
        path: adapter.getPath(),
        method: adapter.getMethod(),
      };

      const result = await httpServer.processHTTPRequest(context, options.paywall);

      if (result.type === 'no-payment-required') {
        await next();
        return;
      }

      if (result.type === 'payment-error') {
        count(adapter.getHeader('payment-signature') ? 'PaymentRejected' : 'PaymentRequired');
        logger?.debug('x402 payment not accepted', { status: result.response.status });
        // Assigning res directly (instead of returning a Response) keeps the
        // handler's headers from being merged into this replacement response.
        reqCtx.res = toResponse(result.response);
        return;
      }

      const {
        cancellationDispatcher,
        beforeHandlerSettlement,
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
      } = result;

      reqCtx.set('payment', {
        network: paymentRequirements.network,
        scheme: paymentRequirements.scheme,
        asset: paymentRequirements.asset,
        amount: paymentRequirements.amount,
        payer: payers.get(paymentPayload),
      });
      count('PaymentVerified');

      try {
        await next();
      } catch (error) {
        await cancellationDispatcher.cancel({ reason: 'handler_threw', error });
        count('PaymentCancelled');
        logger?.warn('x402 payment cancelled: handler threw', { path: context.path });
        throw error;
      }

      if (reqCtx.res.status >= 400) {
        await cancellationDispatcher.cancel({
          reason: 'handler_failed',
          responseStatus: reqCtx.res.status,
        });
        count('PaymentCancelled');
        logger?.warn('x402 payment cancelled: handler failed', {
          path: context.path,
          status: reqCtx.res.status,
        });
        return;
      }

      const settlement = await httpServer.processSettlement(
        paymentPayload,
        paymentRequirements,
        declaredExtensions,
        {
          request: context,
          responseBody: Buffer.from(await reqCtx.res.clone().arrayBuffer()),
          responseHeaders: Object.fromEntries(reqCtx.res.headers.entries()),
        },
        undefined,
        beforeHandlerSettlement
      );

      if (!settlement.success) {
        count('SettlementFailed');
        logger?.error('x402 settlement failed', {
          path: context.path,
          errorReason: settlement.errorReason,
        });
        reqCtx.res = toResponse(settlement.response);
        return;
      }

      count('PaymentSettled');
      logger?.debug('x402 payment settled', { path: context.path, transaction: settlement.transaction });

      for (const [name, value] of Object.entries(settlement.headers)) {
        reqCtx.res.headers.set(name, value);
      }
      const cacheControl = reqCtx.res.headers.get('cache-control');
      reqCtx.res.headers.set('cache-control', cacheControl ? `${cacheControl}, private` : 'private');
    };
  }

  return { paid, resourceServer };
}

export { PowertoolsAdapter } from './adapter.js';
export { CachingFacilitatorClient } from './facilitator.js';
