import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:vectorize", "live"];

// Describes the index through the binding: its dimensions come from the
// looked-up index's configuration.
const callerScript = `export default {
  async fetch(request, env) {
    const info = await env.INDEX.describe();
    return new Response("dimensions=" + info.dimensions);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "VectorizeIndexLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const index = yield* Cloudflare.Vectorize.Index("lookup-target", {
      dimensions: 48,
      metric: "cosine",
    });
    return { name: index.indexName.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up index binds by name and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { name } = yield* target;

      const program = Effect.gen(function* () {
        const index = Cloudflare.Vectorize.Index.lookup({ name });
        const caller = yield* Cloudflare.Worker("vectorize-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { INDEX: index },
        });
        return { url: caller.url.as<string>(), dimensions: index.dimensions };
      });
      const out = yield* stack.deploy(program);
      expect(out.dimensions).toBe(48);

      yield* expectUrlContains(out.url, "dimensions=48", { label: "vectorize lookup caller" });

      // A lookup re-resolves to the same index, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["vectorize-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the index alone.
      yield* stack.destroy();
      const survivor = yield* vectorize.getIndex({ accountId, indexName: name });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing index fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("vectorize-lookup-missing", {
            script: callerScript,
            env: { INDEX: Cloudflare.Vectorize.Index.lookup({ name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an index this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Vectorize.Index("lookup-managed", { dimensions: 32, metric: "cosine" });
      const { indexName } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("vectorize-lookup-managed", {
              script: callerScript,
              env: { INDEX: Cloudflare.Vectorize.Index.lookup({ name: indexName }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
