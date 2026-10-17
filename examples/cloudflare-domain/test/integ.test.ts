import { expect } from "bun:test";
import * as Axiom from "@alchemy.run/axiom";
import * as Stripe from "@alchemy.run/stripe";
// Runs under `bun test`: deploying a Worker from Vitest does not yet produce a
// correct bundle (the Effect entrypoint is not detected under Vite's transform).
import { CreatePaymentIntent } from "@distilled.cloud/stripe/stripe";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Domain from "alchemy/Domain";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import Stack from "../alchemy.run.ts";
import { CustomerId } from "../packages/domain/src/Customer/Customer.id.ts";
import { CustomerDashboard } from "../packages/domain/src/Customer/CustomerDashboard.view.ts";
import { CustomerApi } from "../packages/domain/src/CustomerApi.api.ts";
import { sessionClient } from "../packages/domain/src/Session.middleware.ts";
import { mfa, register, transfer } from "../packages/server/test/flows.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers(), Axiom.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/**
 * A typed CustomerApi client signed in as `customerId`: commands over HTTP,
 * every watch a WebSocket to the Durable Object that owns what it reads.
 * Not a browser, so it sends `Authorization` rather than the session cookie:
 * with its calls through `sessionClient`, and on each WebSocket upgrade
 * through Bun's `WebSocket`, which accepts headers.
 */
const customerClient = (url: string, customerId: string) => {
  const token = `customer:${customerId}`;
  const webSockets = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new WebSocket(socketUrl, {
        protocols,
        headers: { authorization: `Bearer ${token}` },
      } as unknown as string[]),
  );
  return CustomerApi.client.pipe(
    Effect.provide(
      Layer.mergeAll(Domain.protocolWebSocket(`${url}/api`), sessionClient(token)).pipe(
        Layer.provide(Layer.mergeAll(FetchHttpClient.layer, webSockets)),
      ),
    ),
  );
};

test(
  "the deployed bank decides, projects, runs policies and streams views",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    // wait for the workers.dev URL to serve this Worker (Cloudflare's own 404 page comes first)
    yield* HttpClient.get(`${base}/health`).pipe(
      Effect.flatMap((res) => res.text),
      Effect.flatMap((body) => (body === "Not Found" ? Effect.void : Effect.fail("not ready"))),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
    );

    const sam = yield* customerClient(base, "c-1");
    const alex = yield* customerClient(base, "c-2");

    // right after a deploy, Durable Objects can still answer with the placeholder
    // script: wait until a read reaches one (any domain answer means it did)
    yield* sam.CustomerDashboard.get(CustomerId.make("c-1")).pipe(
      Effect.retry({
        while: (e) => e._tag === "RpcClientError",
        schedule: Schedule.spaced("1 second"),
        times: 30,
      }),
      Effect.ignore,
    );

    // a command, then a policy (MainAccountProvisioning) opens the account; the dashboard shows it
    const samMain = yield* register(sam, "c-1", "sam");
    const alexMain = yield* register(alex, "c-2", "alex");

    // a command's reply, computed from the committed state in the account's Durable Object
    expect((yield* sam.DepositMoney({ target: samMain, amount: 100 })).reply).toEqual({
      balance: 100,
    });

    // MFA middleware, and ownership enforced by the aggregate against the session's actor
    expect((yield* sam.WithdrawMoney({ target: samMain, amount: 10 }).pipe(Effect.flip))._tag).toBe(
      "MfaRequired",
    );
    expect((yield* sam.WithdrawMoney({ target: samMain, amount: 10 }, mfa)).reply).toEqual({
      balance: 90,
    });
    expect(
      (yield* alex.WithdrawMoney({ target: samMain, amount: 10 }, mfa).pipe(Effect.flip))._tag,
    ).toBe("NotOwner");

    // a process manager across three aggregates, followed by the requester through a multi-source view
    const outcome = yield* transfer(sam, {
      transferId: "t-1",
      from: samMain,
      to: alexMain,
      amount: 40,
    });
    expect(outcome.status).toBe("completed");
    // the recipient sees it arrive on their own account
    const incoming = yield* alex.AccountTransfers.list(alexMain).pipe(
      Effect.filterOrFail(
        (p) => p.entries.length === 1,
        () => "not projected yet",
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
    );
    expect(incoming.entries[0]!.event.direction).toBe("in");

    // Stripe deliveries are signature-checked by consumeEvents before they reach the Bank
    const forged = yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/webhooks/stripe`).pipe(
        HttpClientRequest.setHeader("stripe-signature", "t=1,v1=00"),
        HttpClientRequest.bodyText("{}"),
      ),
    );
    expect(forged.status).toBe(401);

    // views are eventually consistent: wait until the transfer has been projected
    const page = yield* sam.Statement.list(samMain, { order: "desc" }).pipe(
      Effect.filterOrFail(
        (p) => p.entries.length === 3,
        () => "not projected yet",
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
    );
    expect(page.entries.map((e) => e.event.kind)).toEqual([
      "transfer-out",
      "withdrawal",
      "deposit",
    ]);

    // a projection (AccountCards) appends to a stream; its Durable Object pushes each new card
    const card = yield* sam.AccountCard.watch(samMain).pipe(
      Stream.filter((latest) => latest?.event.balance === 50),
      Stream.runHead,
      Effect.timeout("20 seconds"),
    );
    expect(Option.getOrThrow(card)?.event).toMatchObject({ owner: "sam", balance: 50 });
    // the stream's validate: only the owner reads the card
    expect((yield* alex.AccountCard.peek(samMain).pipe(Effect.flip))._tag).toBe("NotOwner");

    // a projection (Ledger) writes D1 in batches; the ledger is served by a plain route
    const ledger = yield* HttpClient.execute(
      HttpClientRequest.get(`${base}/api/ledger/${samMain}`).pipe(
        HttpClientRequest.setHeader("authorization", "Bearer customer:c-1"),
      ),
    ).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map(
        (rows) => rows as ReadonlyArray<{ readonly kind: string; readonly amount: number }>,
      ),
      Effect.filterOrFail(
        (rows) => rows.length === 3,
        () => "not projected yet",
      ),
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
    );
    expect(ledger.map((row) => [row.kind, row.amount])).toEqual([
      ["MoneyDeposited", 100],
      ["MoneyWithdrawn", 10],
      ["TransferDebited", 40],
    ]);

    // a live view (AccountSummary → CustomerDashboard, view to view), pushed by its Durable Object
    const dashboard = yield* sam.CustomerDashboard.watch(CustomerId.make("c-1")).pipe(
      Stream.filter((d) => d !== null && CustomerDashboard.computed.totalBalance(d) === 50),
      Stream.runHead,
      Effect.timeout("20 seconds"),
    );
    expect(Option.getOrThrow(dashboard)).toMatchObject({ name: "sam" });
  }).pipe(Effect.scoped),
  { timeout: 180_000 },
);

// Real delivery to a fresh workers.dev URL waits on edge propagation and
// Stripe's retry backoff (minutes), so it is opt-in.
test.skipIf(process.env.STRIPE_TEST_REAL_DELIVERY !== "1")(
  "a Stripe payment settles onto an account through consumeEvents",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const sam = yield* customerClient(base, "c-3");
    const accountId = yield* register(sam, "c-3", "sam");

    // a test-mode card payment whose metadata names the account
    yield* CreatePaymentIntent({
      amount: 500,
      currency: "usd",
      confirm: true,
      payment_method: "pm_card_visa",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { accountId },
    }).pipe(
      Effect.provide(
        Stripe.fromAuthProvider().pipe(
          Layer.provideMerge(Stripe.StripeAuth),
          Layer.provideMerge(FetchHttpClient.layer),
        ),
      ),
    );

    const page = yield* sam.Statement.list(accountId, { order: "desc" }).pipe(
      Effect.filterOrFail(
        (p) => p.entries.some((e) => e.event.kind === "settlement"),
        () => "not delivered yet",
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
    );
    expect(page.entries[0]!.event).toMatchObject({
      kind: "settlement",
      amount: 500,
      balance: 500,
    });
  }).pipe(Effect.scoped),
  { timeout: 240_000 },
);
