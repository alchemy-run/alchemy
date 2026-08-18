import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Plan-level coverage for non-fetch delivery on the effectful AWS Website
 * composites (Serve/DESIGN.md, AWS phase 4):
 *
 * - **Single-handler frameworks** (Nextjs, SvelteKit, Vite SSR, Astro —
 *   the mount design): the impl threads DIRECTLY into the collect-only
 *   site server Lambda. Event-source mappings and their IAM target the
 *   server function itself, and NO sibling `<id>-Handlers` Lambda
 *   deploys — the generated `makeFrameworkFunctionHandler` entry
 *   dispatches the events on the same function.
 * - **Sibling delivery** (frameworks not yet converted — Nuxt): the impl
 *   deploys a SIBLING effect Lambda from the same site module; the
 *   mapping and consume-IAM target the sibling and the site Lambda stays
 *   fetch-only.
 *
 * Nothing in this file builds or deploys.
 */

const nodeOf = (plan: any, logicalId: string, type?: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) =>
      node.resource?.LogicalId === logicalId &&
      (type === undefined || node.resource?.Type === type),
  );

const entryOf = (plan: any, logicalId: string, type?: string) =>
  (Object.entries(plan.resources) as [string, any][]).find(
    ([, node]) =>
      node.resource?.LogicalId === logicalId &&
      (type === undefined || node.resource?.Type === type),
  );

const statementsOf = (node: any): any[] =>
  (node?.bindings ?? []).flatMap(
    (binding: any) => binding.data?.policyStatements ?? [],
  );

const hasAction = (statements: any[], action: string): boolean =>
  statements.some((statement: any) =>
    (statement.Action ?? []).includes(action),
  );

const okFetch = {
  fetch: Effect.succeed(HttpServerResponse.text("ok")),
};

describe.concurrent("single-handler non-fetch delivery (plan)", () => {
  test.provider(
    "Nextjs: a queue consumer targets the site server Lambda; no sibling deploys",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const queue = yield* AWS.SQS.Queue("Jobs", {});
            const table = yield* AWS.DynamoDB.Table("SiblingVisits", {
              partitionKey: "pk",
              attributes: { pk: "S" },
            });
            yield* AWS.Website.Nextjs(
              "NextSite",
              { main: import.meta.url },
              Effect.gen(function* () {
                // Capability used by the fetch surface AND the consumer:
                // env + IAM land once, on the site server Lambda.
                const getItem = yield* AWS.DynamoDB.GetItem(table);
                void getItem;
                // Non-fetch surface: dispatched by the generated
                // single-handler entry on the SAME function.
                yield* AWS.SQS.consumeQueueMessages(queue, (records) =>
                  records.pipe(
                    Stream.runForEach((record) => Effect.log(record.body)),
                  ),
                );
                return okFetch;
              }).pipe(
                Effect.provide(AWS.Lambda.QueueEventSource),
                Effect.provide(AWS.DynamoDB.GetItemHttp),
              ),
            );
          }),
        );

        // No sibling Lambda anywhere in the plan.
        expect(nodeOf(plan, "NextSite-Handlers")).toBeUndefined();

        // The ONLY effect mapping in the plan targets the site server
        // Lambda (the OpenNext topology's own RevalidationEventSource is
        // excluded).
        const mappings = (
          Object.entries(plan.resources) as [string, any][]
        ).filter(
          ([, node]) =>
            node.resource?.Type === "AWS.Lambda.EventSourceMapping" &&
            node.resource?.LogicalId !== "RevalidationEventSource",
        );
        expect(mappings).toHaveLength(1);

        // The collect-only site server Lambda carries BOTH surfaces: the
        // shared capability IAM/env (fetch) AND the event source's
        // consume IAM — the single-handler entry dispatches its events.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(server.props.bundle).toBe(false);
        const serverStatements = statementsOf(server);
        expect(hasAction(serverStatements, "dynamodb:GetItem")).toBe(true);
        expect(hasAction(serverStatements, "sqs:ReceiveMessage")).toBe(true);
        const serverEnvKeys = Object.keys(server.props.env ?? {});
        expect(serverEnvKeys.some((key) => key.includes("tableName"))).toBe(
          true,
        );

        // The impl-declared resources are shared, not duplicated.
        expect(nodeOf(plan, "Jobs")).toBeDefined();
        expect(nodeOf(plan, "SiblingVisits")).toBeDefined();
      }),
  );

  test.provider("Nextjs: a fetch-only impl deploys no sibling", (stack) =>
    Effect.gen(function* () {
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          yield* AWS.Website.Nextjs(
            "FetchOnlySite",
            { main: import.meta.url },
            Effect.succeed(okFetch),
          );
        }),
      );
      expect(nodeOf(plan, "FetchOnlySite-Handlers")).toBeUndefined();
      const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
      expect(server).toBeDefined();
      expect(server.props.runtimeDelivery).toBe("wrapper");
      expect(
        (Object.values(plan.resources) as any[]).filter(
          (node: any) =>
            node.resource?.Type === "AWS.Lambda.EventSourceMapping" &&
            // The plain Nextjs topology has its own revalidation mapping;
            // only effect mappings are in question here.
            node.resource?.LogicalId !== "RevalidationEventSource",
        ),
      ).toHaveLength(0);
    }),
  );

  test.provider(
    "Astro (FrameworkSite path): single-handler — the mapping targets the server",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const queue = yield* AWS.SQS.Queue("AstroJobs", {});
            yield* AWS.Website.Astro(
              "AstroSiblingSite",
              { main: import.meta.url },
              Effect.gen(function* () {
                yield* AWS.SQS.consumeQueueMessages(queue, (records) =>
                  records.pipe(
                    Stream.runForEach((record) => Effect.log(record.body)),
                  ),
                );
                return okFetch;
              }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
            );
          }),
        );

        expect(nodeOf(plan, "AstroSiblingSite-Handlers")).toBeUndefined();

        const mapping = entryOf(plan, "AstroJobs-EventSource");
        expect(mapping).toBeDefined();

        // The site server Lambda carries the consume IAM — its generated
        // single-handler entry dispatches the queue events.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(hasAction(statementsOf(server), "sqs:ReceiveMessage")).toBe(
          true,
        );
      }),
  );

  test.provider(
    "SvelteKit (FrameworkSite path): single-handler — the mapping targets the server",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const queue = yield* AWS.SQS.Queue("KitJobs", {});
            yield* AWS.Website.SvelteKit(
              "KitSiblingSite",
              { main: import.meta.url },
              Effect.gen(function* () {
                yield* AWS.SQS.consumeQueueMessages(queue, (records) =>
                  records.pipe(
                    Stream.runForEach((record) => Effect.log(record.body)),
                  ),
                );
                return okFetch;
              }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
            );
          }),
        );

        expect(nodeOf(plan, "KitSiblingSite-Handlers")).toBeUndefined();

        const mapping = entryOf(plan, "KitJobs-EventSource");
        expect(mapping).toBeDefined();

        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(hasAction(statementsOf(server), "sqs:ReceiveMessage")).toBe(
          true,
        );
      }),
  );

  test.provider(
    "Nuxt (unconverted): the sibling threads through the shared composite",
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const queue = yield* AWS.SQS.Queue("NuxtJobs", {});
            yield* AWS.Website.Nuxt(
              "NuxtSite",
              { main: import.meta.url },
              Effect.gen(function* () {
                yield* AWS.SQS.consumeQueueMessages(queue, (records) =>
                  records.pipe(
                    Stream.runForEach((record) => Effect.log(record.body)),
                  ),
                );
                return okFetch;
              }).pipe(Effect.provide(AWS.Lambda.QueueEventSource)),
            );
          }),
        );

        const sibling = nodeOf(
          plan,
          "NuxtSite-Handlers",
          "AWS.Lambda.Function",
        );
        expect(sibling).toBeDefined();
        expect(sibling.props.functionUrl).toBe(false);
        expect(hasAction(statementsOf(sibling), "sqs:ReceiveMessage")).toBe(
          true,
        );

        const mapping = entryOf(plan, "NuxtJobs-EventSource");
        expect(mapping).toBeDefined();
        expect(mapping![0]).toBe("NuxtSite-Handlers/NuxtJobs-EventSource");

        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        // Nuxt is still the routes-scoped middleware delivery: the
        // framework integration injects the generated effect middleware
        // via `nitro.handlers`, and the site Lambda stays fetch-only.
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(hasAction(statementsOf(server), "sqs:ReceiveMessage")).toBe(
          false,
        );
      }),
  );
});

// The AWS serve dispatch tests (process-exclusive) live in
// test/AWS/Lambda/FetchHandler.test.ts.
