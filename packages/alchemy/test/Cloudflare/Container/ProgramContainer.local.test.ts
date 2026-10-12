import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import ProgramBoxStack, { state } from "./fixtures/program-do/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state,
  dev: true,
});

const HOOK_TIMEOUT = 300_000;

/**
 * A bundled program (`Container.make`) under `schedulingPolicy:
 * "durable_object"`: published as the named image `main`, started by
 * `start()` without an image, and snapshotted and restored by its
 * Durable Object.
 */
describe(
  "program containers scheduled by a Durable Object",
  { tags: ["provider:cloudflare", "provider:cloudflare:container"] },
  () => {
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
              ? r.text.pipe(Effect.flatMap((body) => Effect.fail(new Error(`${r.status}: ${body}`))))
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
      { tags: ["local"], timeout: 240_000 },
    );

    test(
      "a snapshot restores the program's files into a fresh container",
      Effect.gen(function* () {
        const result = JSON.parse(yield* get("/snapshot")) as { fresh: string; restored: string };
        expect(result.fresh).toBe("");
        expect(result.restored).toBe("persisted");
      }),
      { tags: ["local"], timeout: 240_000 },
    );
  },
);
