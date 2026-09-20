import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { ConflictingWebhookEndpoint } from "@/Serverless/Webhook.ts";
import {
  consumeEvents,
  ConsumeEventsLive,
  webhookSecretEnvName,
} from "@/Stripe/ConsumeEvents.ts";
import { CustomerCreated, InvoicePaid } from "@/Stripe/Events.ts";
import { expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createHmac } from "node:crypto";

const WorkerHost = Context.Service<Worker, Worker>(Worker.Self.key);

const runtimeOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        globalThis.__ALCHEMY_RUNTIME__ = previous;
      }),
  );

it.effect(
  "Stripe verifies one body, selects all matching subscribers, and acknowledges only complete processing",
  () =>
    runtimeOnly(
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("stripe-webhooks");
        let customerCalls = 0;
        let invoiceCalls = 0;
        let applicationCalls = 0;
        let fail = true;
        yield* Effect.gen(function* () {
          yield* consumeEvents("Events", { events: [CustomerCreated] }, () =>
            Effect.sync(() => {
              customerCalls++;
            }),
          );
          yield* consumeEvents("Events", { events: [CustomerCreated] }, () =>
            Effect.suspend(() =>
              fail ? Effect.die("subscriber failure") : Effect.void,
            ),
          );
          yield* consumeEvents("Events", { events: [InvoicePaid] }, () =>
            Effect.sync(() => {
              invoiceCalls++;
            }),
          );
          yield* ctx.serve(
            Effect.sync(() => {
              applicationCalls++;
              return HttpServerResponse.text("application");
            }),
          );
        }).pipe(
          Effect.provide(ConsumeEventsLive),
          Effect.provideService(WorkerHost, ctx as unknown as Worker),
          Effect.provideService(RuntimeContext, ctx),
        );
        const exports = yield* ctx.exports;
        const env = { [webhookSecretEnvName()]: "whsec_test" };
        let reads = 0;
        const send = (type: string, valid = true) =>
          Effect.gen(function* () {
            const timestamp = yield* Effect.sync(() =>
              Math.floor(Date.now() / 1000),
            );
            const body = JSON.stringify({
              id: "evt_delivery",
              object: "event",
              type,
              created: timestamp,
              data: { object: { id: "object_1" } },
            });
            const signature = yield* Effect.sync(() =>
              createHmac("sha256", "whsec_test")
                .update(`${timestamp}.${body}`)
                .digest("hex"),
            );
            const request = new Request(
              "https://worker.example/webhooks/stripe",
              {
                method: "POST",
                body,
                headers: {
                  "stripe-signature": `t=${timestamp},v1=${valid ? signature : "0".repeat(64)}`,
                },
              },
            );
            const text = request.text.bind(request);
            request.text = () => {
              reads++;
              return text();
            };
            const [program, services] = exports.default.fetch(
              request,
              env,
              {} as ExecutionContext,
            );
            return yield* (program as Effect.Effect<Response>).pipe(
              Effect.provide(services as Context.Context<never>),
            );
          });
        expect((yield* send("customer.created")).status).toBe(503);
        expect(customerCalls).toBe(1);
        expect(invoiceCalls).toBe(0);
        expect(reads).toBe(1);
        fail = false;
        expect((yield* send("customer.created")).status).toBe(200);
        expect(customerCalls).toBe(2);
        expect((yield* send("invoice.paid")).status).toBe(200);
        expect(invoiceCalls).toBe(1);
        expect((yield* send("customer.created", false)).status).toBe(401);
        expect(customerCalls).toBe(2);
        expect((yield* send("customer.deleted")).status).toBe(200);
        expect(customerCalls).toBe(2);
        expect(applicationCalls).toBe(0);
      }),
    ),
  { exclusive: true },
);

it.effect(
  "Stripe rejects different endpoint IDs claiming the same path",
  () =>
    runtimeOnly(
      Effect.gen(function* () {
        const ctx = makeWorkerRuntimeContext("stripe-conflict");
        const exit = yield* Effect.gen(function* () {
          yield* consumeEvents(
            "First",
            { events: [CustomerCreated] },
            () => Effect.void,
          );
          yield* consumeEvents(
            "Second",
            { events: [InvoicePaid] },
            () => Effect.void,
          );
        }).pipe(
          Effect.provide(ConsumeEventsLive),
          Effect.provideService(WorkerHost, ctx as unknown as Worker),
          Effect.provideService(RuntimeContext, ctx),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toBeInstanceOf(
            ConflictingWebhookEndpoint,
          );
      }),
    ),
  { exclusive: true },
);
