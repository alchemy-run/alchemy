import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:kv", "live"];

// Writes through the namespace found by title and reads back through the
// one found by id: the response proves both bind the same namespace.
const callerScript = `export default {
  async fetch(request, env) {
    await env.BY_TITLE.put("greeting", "hello from a looked-up namespace");
    return new Response((await env.BY_ID.get("greeting")) ?? "not yet");
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "KVNamespaceLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.KV.Namespace("lookup-target");
    return {
      title: namespace.title.as<string>(),
      namespaceId: namespace.namespaceId.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up namespace binds by title and by id, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { title, namespaceId } = yield* target;

      const program = Effect.gen(function* () {
        const byTitle = Cloudflare.KV.Namespace.lookup({ title });
        const caller = yield* Cloudflare.Worker("kv-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: {
            BY_TITLE: byTitle,
            BY_ID: Cloudflare.KV.Namespace.lookup({ namespaceId }),
          },
        });
        return { url: caller.url.as<string>(), namespaceId: byTitle.namespaceId };
      });
      const out = yield* stack.deploy(program);
      expect(out.namespaceId).toBe(namespaceId);

      yield* expectUrlContains(out.url, "hello from a looked-up namespace", {
        label: "kv lookup caller",
      });

      // A lookup re-resolves to the same namespace, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["kv-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the namespace alone.
      yield* stack.destroy();
      const survivor = yield* kv.getNamespace({ accountId, namespaceId });
      expect(survivor.title).toBe(title);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing namespace fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const title = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("kv-lookup-missing", {
            script: callerScript,
            env: { BY_TITLE: Cloudflare.KV.Namespace.lookup({ title }) },
          }),
        ),
        ["LookupNotFoundError", title],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a namespace this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.KV.Namespace("lookup-managed");
      const { title } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("kv-lookup-managed", {
              script: callerScript,
              env: { BY_TITLE: Cloudflare.KV.Namespace.lookup({ title }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
