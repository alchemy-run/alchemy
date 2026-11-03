import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

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

      // The target is deployed first; the caller only knows its name.
      const target = () => Cloudflare.Worker("lookup-target", { script: targetScript });
      const { workerName } = yield* stack.deploy(target());

      const program = Effect.gen(function* () {
        const deployedTarget = yield* target();
        const caller = yield* Cloudflare.Worker("lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: {
            TARGET: Cloudflare.Worker.lookup({ name: workerName }),
            API: Cloudflare.WorkerEntrypoint(Cloudflare.Worker.lookup({ name: workerName }), "Api"),
          },
        });
        return { target: deployedTarget, caller };
      });
      const deployed = yield* stack.deploy(program);

      yield* expectUrlContains(
        deployed.caller.url!,
        "lookup target up | hello alice from lookup target",
        { label: "lookup-bound caller" },
      );

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
