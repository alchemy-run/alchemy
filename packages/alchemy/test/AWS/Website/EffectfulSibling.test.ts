import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const { test } = Test.make({ providers: AWS.providers() });

/**
 * Plan-level coverage for the sibling-function non-fetch delivery
 * (DESIGN §2.1.3) on the effectful Next.js / Nuxt AWS composites: an impl
 * that registers event-source listeners deploys a SIBLING effect Lambda
 * (`Handlers`) from the same site module — the event-source mapping and
 * its IAM target the sibling, the collect-only site server Lambda stays
 * fetch-only, and a fetch-only impl deploys no sibling at all. Nothing in
 * this file builds or deploys.
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

describe.concurrent("sibling-function non-fetch delivery (plan)", () => {
  test.provider(
    "Nextjs: a queue consumer deploys the sibling; the site Lambda stays fetch-only",
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
                // Capability used by BOTH surfaces: env + IAM must land on
                // the site Lambda (fetch) AND the sibling (queue handler).
                const getItem = yield* AWS.DynamoDB.GetItem(table);
                void getItem;
                // Non-fetch surface: rides the sibling.
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

        // The sibling effect Lambda: normal FunctionBundle pipeline (no
        // bundle:false, no delivery stamp), anchored on the SAME site
        // module, with no Function URL — it only ever receives events.
        const sibling = nodeOf(
          plan,
          "NextSite-Handlers",
          "AWS.Lambda.Function",
        );
        expect(sibling).toBeDefined();
        expect(sibling.action).toBe("create");
        expect(sibling.props.main).toBe(import.meta.url);
        expect(sibling.props.functionUrl).toBe(false);
        expect(sibling.props.bundle).toBeUndefined();
        expect(sibling.props.runtimeDelivery).toBeUndefined();

        // The event-source mapping targets the sibling: it nests under
        // the sibling's caller-level logical id (`<siteId>-Handlers` — the
        // FQN shape a hand-declared sibling function would have), and it
        // is the ONLY effect mapping in the plan — the site Lambda got
        // none (the OpenNext topology's own RevalidationEventSource is
        // excluded).
        const mappings = (
          Object.entries(plan.resources) as [string, any][]
        ).filter(
          ([, node]) =>
            node.resource?.Type === "AWS.Lambda.EventSourceMapping" &&
            node.resource?.LogicalId !== "RevalidationEventSource",
        );
        expect(mappings).toHaveLength(1);
        expect(mappings[0][0]).toBe("NextSite-Handlers/Jobs-EventSource");

        // The sibling carries the event source's consume IAM plus the
        // shared capability IAM + env (its handler closes over the same
        // clients).
        const siblingStatements = statementsOf(sibling);
        expect(hasAction(siblingStatements, "sqs:ReceiveMessage")).toBe(true);
        expect(hasAction(siblingStatements, "dynamodb:GetItem")).toBe(true);
        const siblingEnvKeys = Object.keys(sibling.props.env ?? {});
        expect(siblingEnvKeys.some((key) => key.includes("tableName"))).toBe(
          true,
        );

        // The collect-only site server Lambda: wrapper delivery (the
        // derived OpenNext config's custom wrapper mounts the fetch), the
        // shared capability IAM/env (fetch surface), and NO event-source
        // IAM — the framework artifact never sees raw events.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(server.props.bundle).toBe(false);
        const serverStatements = statementsOf(server);
        expect(hasAction(serverStatements, "dynamodb:GetItem")).toBe(true);
        expect(hasAction(serverStatements, "sqs:ReceiveMessage")).toBe(false);
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
            // only effect-siblings are in question here.
            node.resource?.LogicalId !== "RevalidationEventSource",
        ),
      ).toHaveLength(0);
    }),
  );

  test.provider(
    "Astro (FrameworkSite path): the sibling threads through the shared composite",
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

        const sibling = nodeOf(
          plan,
          "AstroSiblingSite-Handlers",
          "AWS.Lambda.Function",
        );
        expect(sibling).toBeDefined();
        expect(sibling.props.functionUrl).toBe(false);
        expect(hasAction(statementsOf(sibling), "sqs:ReceiveMessage")).toBe(
          true,
        );

        const mapping = entryOf(plan, "AstroJobs-EventSource");
        expect(mapping).toBeDefined();
        expect(mapping![0]).toBe(
          "AstroSiblingSite-Handlers/AstroJobs-EventSource",
        );

        // Astro is the auto-inject (wrapper) tier on AWS; the site Lambda
        // stays fetch-only either way — the queue consumer rides the
        // sibling, never the framework artifact.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(hasAction(statementsOf(server), "sqs:ReceiveMessage")).toBe(
          false,
        );
      }),
  );

  test.provider(
    "SvelteKit (FrameworkSite path): the sibling threads through the shared composite",
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

        const sibling = nodeOf(
          plan,
          "KitSiblingSite-Handlers",
          "AWS.Lambda.Function",
        );
        expect(sibling).toBeDefined();
        expect(sibling.props.functionUrl).toBe(false);
        expect(hasAction(statementsOf(sibling), "sqs:ReceiveMessage")).toBe(
          true,
        );

        const mapping = entryOf(plan, "KitJobs-EventSource");
        expect(mapping).toBeDefined();
        expect(mapping![0]).toBe("KitSiblingSite-Handlers/KitJobs-EventSource");

        // SvelteKit is the auto-inject (wrapper) tier on AWS; the site
        // Lambda stays fetch-only either way.
        const server = nodeOf(plan, "Server", "AWS.Lambda.Function");
        expect(server).toBeDefined();
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(hasAction(statementsOf(server), "sqs:ReceiveMessage")).toBe(
          false,
        );
      }),
  );

  test.provider(
    "Nuxt (FrameworkSite path): the sibling threads through the shared composite",
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
        // Nuxt is the auto-inject (wrapper) tier: the framework
        // integration injects the generated effect middleware via
        // `nitro.handlers`.
        expect(server.props.runtimeDelivery).toBe("wrapper");
        expect(hasAction(statementsOf(server), "sqs:ReceiveMessage")).toBe(
          false,
        );
      }),
  );
});

// The AWS serve shell dispatch tests (process-exclusive) live in
// test/Serve/ServeBridgeDispatch.test.ts — an exclusive test in this live
// CloudFront directory FIFO-barriers the whole run.
