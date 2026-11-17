import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:workersforplatforms", "live"];

// Dispatches to the user Worker uploaded into the looked-up namespace.
const platformScript = `export default {
  async fetch(request, env) {
    return env.DISPATCH.get(env.USER_WORKER).fetch(request);
  },
};`;

const userWorkerScript = `export default {
  async fetch() {
    return new Response("hello from a looked-up dispatch namespace");
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "DispatchNamespaceLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("lookup-target");
    return { name: namespace.name.as<string>(), namespaceId: namespace.namespaceId.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up dispatch namespace takes user Workers and dispatches, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { name, namespaceId } = yield* target;

      const program = Effect.gen(function* () {
        const namespace = Cloudflare.WorkersForPlatforms.DispatchNamespace.lookup({ name });
        const userWorker = yield* Cloudflare.Worker("dispatch-lookup-user", {
          namespace,
          script: userWorkerScript,
        });
        const platform = yield* Cloudflare.Worker("dispatch-lookup-platform", {
          script: platformScript,
          workersDev: true,
          env: { DISPATCH: namespace, USER_WORKER: userWorker.workerName },
        });
        return { url: platform.url.as<string>(), namespaceId: namespace.namespaceId };
      });
      const out = yield* stack.deploy(program);
      expect(out.namespaceId).toBe(namespaceId);

      yield* expectUrlContains(out.url, "hello from a looked-up dispatch namespace", {
        label: "dispatch lookup platform",
      });

      // A lookup re-resolves to the same namespace, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["dispatch-lookup-user"].action).toBe("noop");
      expect(plan.resources["dispatch-lookup-platform"].action).toBe("noop");

      // Destroying the stack removes its user Worker but leaves the namespace.
      yield* stack.destroy();
      const survivor = yield* wfp.getDispatchNamespace({ accountId, dispatchNamespace: name });
      expect(survivor.namespaceId).toBe(namespaceId);
      expect(survivor.scriptCount ?? 0).toBe(0);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing dispatch namespace fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("dispatch-lookup-missing", {
            script: platformScript,
            env: { DISPATCH: Cloudflare.WorkersForPlatforms.DispatchNamespace.lookup({ name }) },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a dispatch namespace this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.WorkersForPlatforms.DispatchNamespace("lookup-managed");
      const { name } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("dispatch-lookup-managed-caller", {
              script: platformScript,
              env: { DISPATCH: Cloudflare.WorkersForPlatforms.DispatchNamespace.lookup({ name }) },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
