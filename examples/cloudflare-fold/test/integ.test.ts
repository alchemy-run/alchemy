import { expect } from "bun:test";
// Runs under `bun test`: deploying a Worker from Vitest does not yet produce a
// correct bundle (the Effect entrypoint is not detected under Vite's transform).
import { CreatePaymentIntent } from "@distilled.cloud/stripe/stripe";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Api } from "alchemy/Fold";
import * as Stripe from "alchemy/Stripe";
import * as Test from "alchemy/Test/Bun";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import Stack from "../alchemy.run.ts";
import { CustomerApi } from "../src/CustomerApi/CustomerApi.ts";
import { customerSessionClient } from "../src/CustomerApi/CustomerSession.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(destroy(Stack).pipe(Effect.andThen(deploy(Stack))));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const mfa = { headers: { "x-mfa-code": "000000" } };

/** A typed CustomerApi client over HTTP, signed in as `customerId`. */
const customerClient = (url: string, customerId: string) =>
  CustomerApi.client.pipe(
    Effect.provide(
      Layer.mergeAll(
        Api.protocolHttp(`${url}/api`),
        customerSessionClient(`customer:${customerId}`),
      ).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  );

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

    // a mutation that waits for a policy (MainAccountProvisioning) to open the account
    const samMain = (yield* sam.register({ name: "sam" })).accountId;
    const alexMain = (yield* alex.register({ name: "alex" })).accountId;

    // read-your-write through the AccountSummary view's Durable Object
    expect(yield* sam.deposit({ accountId: samMain, amount: 100 })).toEqual({
      accountId: samMain,
      owner: "sam",
      balance: 100,
      frozen: false,
    });

    // MFA middleware, a reply, and ownership enforced by the aggregate
    expect((yield* sam.withdraw({ accountId: samMain, amount: 10 }).pipe(Effect.flip))._tag).toBe(
      "MfaRequired",
    );
    expect(yield* sam.withdraw({ accountId: samMain, amount: 10 }, mfa)).toEqual({ balance: 90 });
    expect(
      (yield* alex.withdraw({ accountId: samMain, amount: 10 }, mfa).pipe(Effect.flip))._tag,
    ).toBe("NotOwner");

    // a process manager across three aggregates; the mutation waits on a multi-source view
    const transfer = yield* sam.transfer({ from: samMain, to: alexMain, amount: 40 }, mfa);
    expect(transfer.status).toBe("completed");
    expect((yield* alex.transferStatus({ transferId: transfer.transferId })).status).toBe(
      "completed",
    );

    // Stripe deliveries are signature-checked by consumeEvents before they reach the Bank
    const forged = yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/webhooks/stripe`).pipe(
        HttpClientRequest.setHeader("stripe-signature", "t=1,v1=00"),
        HttpClientRequest.bodyText("{}"),
      ),
    );
    expect(forged.status).toBe(401);

    // feeds, eventually consistent: wait until the transfer has been projected
    const page = yield* sam.statement({ accountId: samMain }).pipe(
      Effect.filterOrFail(
        (p) => p.entries.length === 3,
        () => "not projected yet",
      ),
      Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 20 }),
    );
    expect(page.entries.map((e) => e.kind)).toEqual(["transfer-out", "withdrawal", "deposit"]);

    // a live subscription: view-to-view (AccountSummary → CustomerDashboard) plus watchEach,
    // streamed to the client over NDJSON
    const dashboard = yield* sam.dashboard({}).pipe(
      Stream.filter((d) => d.totalBalance === 50),
      Stream.runHead,
      Effect.timeout("20 seconds"),
    );
    expect(Option.getOrThrow(dashboard)).toMatchObject({ name: "sam", totalBalance: 50 });
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
    const { accountId } = yield* sam.register({ name: "sam" });

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

    const page = yield* sam.statement({ accountId }).pipe(
      Effect.filterOrFail(
        (p) => p.entries.some((e) => e.kind === "settlement"),
        () => "not delivered yet",
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
    );
    expect(page.entries[0]).toMatchObject({ kind: "settlement", amount: 500, balance: 500 });
  }).pipe(Effect.scoped),
  { timeout: 240_000 },
);
