import { GitHubRepositoryEventSourceLive } from "@/Cloudflare/Workers/GitHubRepositoryEventSource.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import { consumeRepositoryEvents } from "@/GitHub/RepositoryEventSource.ts";
import * as Output from "@/Output.ts";
import { Resource } from "@/Resource.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import type { StackSpec } from "@/Stack.ts";
import { StackContext } from "@/StackContext.ts";
import { inMemoryState } from "@/State/InMemoryState.ts";
import { consumeEvents, ConsumeEventsLive } from "@/Stripe/ConsumeEvents.ts";
import { CustomerCreated, InvoicePaid } from "@/Stripe/Events.ts";
import { expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const WorkerHost = Context.Service<Worker, Worker>(Worker.Self.key);

it.effect(
  "webhook resources resolve the union of all subscriptions after initialization",
  () =>
    Effect.gen(function* () {
      const stack: Omit<StackSpec, "output"> = {
        name: "WebhookUnion",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      };
      yield* Effect.gen(function* () {
        const WorkerResource = yield* Resource<Worker>("Cloudflare.Worker");
        const resource = yield* WorkerResource("Host", {});
        const host = Object.assign(resource, makeWorkerRuntimeContext("Host"));
        yield* Effect.gen(function* () {
          yield* consumeRepositoryEvents(
            { owner: "acme", repository: "api", events: ["push"] },
            () => Effect.void,
          );
          yield* consumeRepositoryEvents(
            { owner: "acme", repository: "api", events: ["issues"] },
            () => Effect.void,
          );
          yield* consumeEvents(
            "Events",
            { events: [CustomerCreated] },
            () => Effect.void,
          );
          yield* consumeEvents(
            "Events",
            { events: [InvoicePaid] },
            () => Effect.void,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(GitHubRepositoryEventSourceLive, ConsumeEventsLive),
          ),
          Effect.provideService(WorkerHost, host),
          Effect.provideService(RuntimeContext, host),
        );
        const hooks = Object.values(stack.resources).filter(
          (resource) => resource.Type === "GitHub.Webhook",
        );
        const endpoints = Object.values(stack.resources).filter(
          (resource) => resource.Type === "Stripe.WebhookEndpoint",
        );
        expect(hooks).toHaveLength(1);
        expect(endpoints).toHaveLength(1);
        const upstream = { Host: { url: "https://worker.example" } };
        expect(yield* Output.evaluate(hooks[0]!.Props, upstream)).toMatchObject(
          {
            events: ["issues", "push"],
            url: "https://worker.example/__alchemy/github/acme/api",
          },
        );
        expect(
          yield* Output.evaluate(endpoints[0]!.Props, upstream),
        ).toMatchObject({
          enabledEvents: [CustomerCreated, InvoicePaid],
          url: "https://worker.example/webhooks/stripe",
        });
      }).pipe(
        Effect.provideService(StackContext, stack),
        Effect.provide(inMemoryState()),
      );
    }),
);
