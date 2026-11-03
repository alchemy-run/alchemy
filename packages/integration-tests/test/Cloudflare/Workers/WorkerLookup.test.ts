import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const targetScript = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Api extends WorkerEntrypoint {
  async greet(name) {
    return "hello " + name + " from lookup target";
  }
}
export default {
  async fetch() {
    return new Response("lookup target up");
  },
};`;

const callerScript = `export default {
  async fetch(request, env) {
    try {
      const page = await (await env.TARGET.fetch("https://target/")).text();
      return new Response(page + " | " + (await env.API.greet("alice")));
    } catch (err) {
      return new Response("caller failed: " + err.message, { status: 500 });
    }
  },
};`;

// The target belongs to another stack, as a lookup's target always should:
// the caller's stack only knows its name.
const TargetStack = Alchemy.Stack(
  "WorkerLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const target = yield* Cloudflare.Worker("lookup-target", { script: targetScript });
    return { workerName: target.workerName.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

/**
 * `Cloudflare.Worker.lookup({ name })` binds a Worker found by its script
 * name — as a plain service binding and through `WorkerEntrypoint` — exactly
 * like a declared Worker. The caller's response proves both bindings reached
 * the looked-up script.
 */
test.provider(
  "a looked-up Worker binds as a service and as a named entrypoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { workerName } = yield* target;

      const program = Cloudflare.Worker("lookup-caller", {
        script: callerScript,
        workersDev: true,
        env: {
          TARGET: Cloudflare.Worker.lookup({ name: workerName }),
          API: Cloudflare.WorkerEntrypoint(Cloudflare.Worker.lookup({ name: workerName }), "Api"),
        },
      });
      const caller = yield* stack.deploy(program);

      yield* expectUrlContains(caller.url!, "lookup target up | hello alice from lookup target", {
        label: "lookup-bound caller",
      });

      // A lookup re-resolves to the same Worker, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
);

/**
 * Looking up a Worker this stack manages is always a mistake: the lookup has
 * no dependency on it, so the stack could delete or replace it under the
 * caller. The deploy fails with `LookupOfManagedResourceError` instead.
 */
test.provider(
  "a lookup of a Worker this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const managed = () => Cloudflare.Worker("lookup-managed", { script: targetScript });
      const { workerName } = yield* stack.deploy(managed());

      const exit = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("lookup-managed-caller", {
              script: callerScript,
              env: { TARGET: Cloudflare.Worker.lookup({ name: workerName }) },
            });
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const pretty = Cause.pretty(exit.cause);
        expect(pretty).toContain("LookupOfManagedResourceError");
        expect(pretty).toContain("lookup-managed");
      }

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);

/**
 * A lookup that matches no Worker fails the deploy with
 * `LookupNotFoundError` instead of uploading a dangling service binding.
 */
test.provider(
  "a lookup of a missing Worker fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const name = `missing-${stack.stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
      const exit = yield* Effect.exit(
        stack.deploy(
          Cloudflare.Worker("lookup-missing-caller", {
            script: callerScript,
            env: { TARGET: Cloudflare.Worker.lookup({ name }) },
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const pretty = Cause.pretty(exit.cause);
        expect(pretty).toContain("LookupNotFoundError");
        expect(pretty).toContain(name);
      }

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);
