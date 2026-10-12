import * as Cloudflare from "alchemy/Cloudflare";
import * as FoldCloudflare from "alchemy/Fold/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Bank, BankPolicies } from "./Bank.ts";
import { CustomerApi } from "./CustomerApi/CustomerApi.ts";
import { SiftFraudCheck } from "./Fraud/SiftFraudCheck.ts";
import { MfaChallengeLive } from "./MfaChallenge.ts";
import { SessionLive } from "./Session.ts";
import { StripePayments } from "./Settlement/StripePayments.ts";
import { StripeSettlements } from "./Settlement/StripeSettlements.ts";
import { SupportApi } from "./SupportApi/SupportApi.ts";

/**
 * Everything the Worker serves: the middleware both Apis declare, and the
 * Bank hosted on Durable Objects. Swap `FoldCloudflare.DurableObjects` for
 * `Fold.InMemory` and nothing else changes.
 */
const BankLive = Layer.mergeAll(SessionLive, MfaChallengeLive, Stripe.ConsumeEventsLive).pipe(
  Layer.provideMerge(Bank.layer(BankPolicies)),
  Layer.provide(Layer.mergeAll(FoldCloudflare.DurableObjects, SiftFraudCheck, StripePayments)),
);

export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
  "BankWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const customerApi = yield* CustomerApi.httpEffect;
    const supportApi = yield* SupportApi.httpEffect;
    // Claims POST /webhooks/stripe and provisions the Stripe webhook endpoint.
    yield* StripeSettlements;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path.startsWith("/api")) return yield* customerApi;
        if (path.startsWith("/support")) return yield* supportApi;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(BankLive)),
) {}
