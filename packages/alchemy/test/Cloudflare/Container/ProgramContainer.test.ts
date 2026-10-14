import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import ProgramBoxStack, { state } from "./fixtures/program-do/stack.ts";

const HOOK_TIMEOUT = 600_000;

/**
 * A bundled program hosted as an `AI.Sandbox` on a Cloudflare Container
 * (`Cloudflare.Containers.Sandbox`, scheduled by its Durable Object): the
 * program is the Container's one image, started by `start({ size })`, and
 * snapshotted and restored by its Durable Object.
 */
describe.each([
  { dev: true, mode: "local" },
  { dev: false, mode: "live" },
])("program containers scheduled by a Durable Object (dev: $dev)", ({ dev, mode }) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state,
    dev,
  });
  {
    const stack = beforeAll(deploy(ProgramBoxStack), { timeout: HOOK_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ProgramBoxStack), {
      timeout: HOOK_TIMEOUT,
    });

    const get = (path: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;
        return yield* client.get(new URL(path, url)).pipe(
          Effect.flatMap((r) =>
            r.status !== 200
              ? r.text.pipe(
                  Effect.flatMap((body) => Effect.fail(new Error(`${r.status}: ${body}`))),
                )
              : r.text,
          ),
          Effect.timeout("90 seconds"),
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
        );
      });

    test(
      "start() runs the bundled program",
      Effect.gen(function* () {
        expect(yield* get("/write-read")).toBe("hello");
      }),
      { tags: [mode, "provider:cloudflare", "provider:cloudflare:container"], timeout: 300_000 },
    );

    // Docker gives every local container the host's memory: sizes only differ live.
    test.skipIf(dev)(
      "start({ size }) starts on the size's instance type",
      Effect.gen(function* () {
        // lite: 256 MiB; standard-1: 4 GiB.
        const small = Number(yield* get("/memory?size=small"));
        const large = Number(yield* get("/memory?size=large"));
        expect(small).toBeGreaterThan(0);
        expect(small).toBeLessThan(1024 ** 3);
        expect(large).toBeGreaterThan(2 * 1024 ** 3);
      }),
      { tags: [mode, "provider:cloudflare", "provider:cloudflare:container"], timeout: 300_000 },
    );

    test(
      "a snapshot restores the program's files into a fresh container",
      Effect.gen(function* () {
        const result = JSON.parse(yield* get("/snapshot")) as { fresh: string; restored: string };
        expect(result.fresh).toBe("");
        expect(result.restored).toBe("persisted");
      }),
      { tags: [mode, "provider:cloudflare", "provider:cloudflare:container"], timeout: 300_000 },
    );
  }
});
