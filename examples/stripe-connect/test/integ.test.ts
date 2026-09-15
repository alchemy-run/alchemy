import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Stripe from "alchemy/Stripe";
import * as Test from "alchemy/Test/Bun";
import { DeleteAccount, GetAccountByAccount } from "@distilled.cloud/stripe/stripe";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Stripe.providers()),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band verification (GetAccount/DeleteAccount) resolves the same
// stored Stripe key the deploy uses.
const StripeHttp = Layer.mergeAll(
  Stripe.StripeAuth,
  Stripe.fromAuthProvider(),
  FetchHttpClient.layer,
);

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test.skipIf(process.env.STRIPE_TEST_CONNECT !== "1")(
  "onboards a connected account and records it in D1",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    yield* getWhenReady(base);

    const onboard = yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/onboard`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ email: "merchant@example.com" }),
      ),
    );
    expect(onboard.status).toBe(201);
    const body = (yield* onboard.json) as {
      accountId: string;
      onboardingUrl: string;
    };
    expect(body.accountId).toMatch(/^acct_/);
    expect(body.onboardingUrl).toMatch(/^https:\/\//);

    const fetched = yield* GetAccountByAccount({ account: body.accountId }).pipe(
      Effect.provide(StripeHttp),
    );
    expect(fetched.id).toEqual(body.accountId);
    expect(fetched.type).toEqual("express");

    const recorded = yield* HttpClient.execute(
      HttpClientRequest.get(`${base}/accounts/${body.accountId}`),
    );
    expect(recorded.status).toBe(200);
    const row = (yield* recorded.json) as {
      account: { id: string; email: string } | null;
    };
    expect(row.account?.id).toEqual(body.accountId);
    expect(row.account?.email).toEqual("merchant@example.com");

    yield* DeleteAccount({ account: body.accountId }).pipe(
      Effect.catch(() => Effect.void),
      Effect.provide(StripeHttp),
    );
  }),
  { timeout: 180_000 },
);
