import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:ai", "live"];

// Reports the runtime shape of each binding: an `ai_search` binding exposes
// `search()`, an `ai_search_namespace` binding exposes `get(name)`.
const callerScript = `export default {
  async fetch(request, env) {
    return new Response(
      "instance:" + typeof env.SEARCH.search + " namespace:" + typeof env.NS.get,
    );
  },
};`;

// The targets belong to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AiSearchLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("lookup-source", { forceDestroy: true });
    const namespace = yield* Cloudflare.AI.SearchNamespace("lookup-target-ns");
    const search = yield* Cloudflare.AI.Search("lookup-target", { source: bucket });
    return {
      namespace: namespace.name.as<string>(),
      instanceId: search.instanceId.as<string>(),
      instanceNamespace: search.namespace.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up AI Search instance and namespace bind, and survive destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { namespace, instanceId, instanceNamespace } = yield* target;

      const program = Effect.gen(function* () {
        const instance = Cloudflare.AI.SearchInstance.lookup({
          instanceId,
          namespace: instanceNamespace,
        });
        const caller = yield* Cloudflare.Worker("search-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: {
            SEARCH: instance,
            NS: Cloudflare.AI.SearchNamespace.lookup({ name: namespace }),
          },
        });
        return { url: caller.url.as<string>(), instanceId: instance.instanceId };
      });
      const out = yield* stack.deploy(program);
      expect(out.instanceId).toBe(instanceId);

      yield* expectUrlContains(out.url, "instance:function namespace:function", {
        label: "search lookup caller",
      });

      // A lookup re-resolves to the same instance and namespace, so nothing
      // changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["search-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked them up leaves both alone.
      yield* stack.destroy();
      const ns = yield* aisearch.readNamespace({ accountId, name: namespace });
      expect(ns.name).toBe(namespace);
      const survivor = yield* aisearch.readNamespaceInstance({
        accountId,
        namespace: instanceNamespace,
        id: instanceId,
      });
      expect(survivor.id).toBe(instanceId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing AI Search instance or namespace fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage).slice(0, 28);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("search-lookup-missing-instance", {
            script: callerScript,
            env: { SEARCH: Cloudflare.AI.SearchInstance.lookup({ instanceId: name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("search-lookup-missing-namespace", {
            script: callerScript,
            env: { NS: Cloudflare.AI.SearchNamespace.lookup({ name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an AI Search namespace this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.AI.SearchNamespace("lookup-managed");
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("search-lookup-managed-caller", {
              script: callerScript,
              env: { NS: Cloudflare.AI.SearchNamespace.lookup({ name }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
