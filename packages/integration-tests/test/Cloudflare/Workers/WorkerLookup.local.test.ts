import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
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

// The target belongs to another stack and is really deployed, even in dev.
const TargetStack = Alchemy.Stack(
  "WorkerLookupDevTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const target = yield* Cloudflare.Worker("lookup-dev-target", { script: targetScript }).pipe(
      Alchemy.remote(),
    );
    return { workerName: target.workerName.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

/**
 * Under `alchemy dev` a looked-up Worker is deployed, not run locally, so the
 * dev Worker reaches it through the remote-binding bridge — as a plain
 * service binding and through a named entrypoint.
 */
test.provider(
  "a dev worker calls a looked-up worker through the remote bridge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { workerName } = yield* target;

      const caller = yield* stack.deploy(
        Cloudflare.Worker("lookup-dev-caller", {
          main: pathe.resolve(import.meta.dirname, "fixtures/lookup/caller.ts"),
          env: {
            TARGET: Cloudflare.Worker.lookup({ name: workerName }),
            API: Cloudflare.WorkerEntrypoint(Cloudflare.Worker.lookup({ name: workerName }), "Api"),
          },
        }),
      );

      expect(caller.url).toMatch(/^http:\/\/localhost:\d+$/);
      yield* expectUrlContains(caller.url!, "lookup target up | hello alice from lookup target", {
        label: "dev lookup caller",
      });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local", "live"],
    timeout: 240_000,
  },
);
