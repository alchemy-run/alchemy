import * as Cloudflare from "alchemy/Cloudflare";
import * as DomainCloudflare from "alchemy/Domain/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Account } from "./Account/Account.ts";
import { AccountSummary } from "./Account/AccountSummary.ts";
import { Bank, BankHandlers } from "./Bank.ts";
import { CustomerApi } from "./CustomerApi/CustomerApi.ts";
import { SiftFraudCheck } from "./Fraud/SiftFraudCheck.ts";
import { D1LedgerStore, LedgerStore } from "./Ledger/LedgerStore.ts";
import { MfaChallengeLive } from "./MfaChallenge.ts";
import { actorOf, SessionLive, sessionRoute } from "./Session.ts";
import { StripePayments } from "./Settlement/StripePayments.ts";
import { StripeSettlements } from "./Settlement/StripeSettlements.ts";
import { SupportApi } from "./SupportApi/SupportApi.ts";

/**
 * Everything the Worker serves: the middleware both Apis declare, and the
 * Bank hosted on Durable Objects, with the ledger in D1. Swap
 * `DomainCloudflare.DurableObjects` for `Domain.InMemory` and nothing else changes.
 */
const BankLive = Layer.mergeAll(SessionLive, MfaChallengeLive, Stripe.ConsumeEventsLive).pipe(
  Layer.provideMerge(Bank.layer(BankHandlers)),
  Layer.provideMerge(D1LedgerStore),
  Layer.provide(
    Layer.mergeAll(
      DomainCloudflare.DurableObjects,
      SiftFraudCheck,
      StripePayments,
      Cloudflare.D1.QueryDatabaseBinding,
    ),
  ),
);

/** `/api/ledger/<account>`: the ledger is a store the bank owns, so it is served by a plain route. */
const LEDGER = /^\/api\/ledger\/([^/]+)$/;

export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
  "BankWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const customerApi = yield* CustomerApi.httpEffect;
    const supportApi = yield* SupportApi.httpEffect;
    const ledger = yield* LedgerStore;
    const summaries = yield* AccountSummary;
    const ledgerRoute = (accountId: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const actor = actorOf(request.headers);
        if (Option.isNone(actor)) return HttpServerResponse.empty({ status: 401 });
        const summary = yield* summaries.query(Account.ref(accountId)).pipe(Effect.orDie);
        const owner = Option.getOrNull(summary)?.customerId;
        if (actor.value._tag === "Customer" && owner !== actor.value.customerId) {
          return HttpServerResponse.empty({ status: 404 });
        }
        return yield* HttpServerResponse.json(yield* ledger.forAccount(accountId));
      });
    // Claims POST /webhooks/stripe and provisions the Stripe webhook endpoint.
    yield* StripeSettlements;
    return {
      // The foldkit app reaches /api through its own Worker, on its own origin,
      // so the session cookie needs no cross-origin allowances.
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/api/session") return yield* sessionRoute;
        const ledgerPath = LEDGER.exec(path);
        if (ledgerPath) return yield* ledgerRoute(decodeURIComponent(ledgerPath[1]!));
        if (path.startsWith("/api")) return yield* customerApi;
        if (path.startsWith("/support")) return yield* supportApi;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(BankLive)),
) {}
