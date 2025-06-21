import { test } from "vitest";
import { Worker, WorkerStub } from "../../src/cloudflare/index.ts";

test("worker-stub-types", () => {
  // type-only test
  async function _() {
    const { WorkerEntrypoint } = await import("cloudflare:workers");

    class MyWorker extends WorkerEntrypoint {
      async foo() {
        return "foo";
      }
    }

    const workerA = await Worker("workerA", {
      entrypoint: "index.ts",
      name: "workerA",
      bindings: {
        workerB: await WorkerStub<MyWorker>("workerB", {
          name: "workerB",
        }),
      },
    });

    const _workerB = await Worker("workerB", {
      entrypoint: "index.ts",
      name: "workerB",
      bindings: {
        workerA,
      },
    });

    const env = workerA.Env;

    const _string: string = await env.workerB.foo();
    // @ts-expect-error
    const _number: number = await env.workerB.foo();
    // @ts-expect-error
    env.workerB.bar();
  }
});
