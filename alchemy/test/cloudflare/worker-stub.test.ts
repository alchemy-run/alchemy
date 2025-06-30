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
      adopt: true,
      bindings: {
        workerB: await WorkerStub<MyWorker>("workerB", {
          name: "workerB",
        }),
      },
    });

    const _workerB = await Worker("workerB", {
      entrypoint: "index.ts",
      name: "workerB",
      adopt: true,
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

test("worker-stub-url-types", () => {
  // type-only test for URL functionality
  async function _() {
    // Test with URL enabled (default)
    const stubWithUrl = await WorkerStub("stub-with-url", {
      name: "stub-with-url",
    });

    // Should have URL property
    const _url1: string | undefined = stubWithUrl.url;

    // Test with URL explicitly enabled
    const stubExplicitUrl = await WorkerStub("stub-explicit-url", {
      name: "stub-explicit-url",
      url: true,
    });

    const _url2: string | undefined = stubExplicitUrl.url;

    // Test with URL disabled
    const stubNoUrl = await WorkerStub("stub-no-url", {
      name: "stub-no-url",
      url: false,
    });

    const _url3: string | undefined = stubNoUrl.url;
  }
});
