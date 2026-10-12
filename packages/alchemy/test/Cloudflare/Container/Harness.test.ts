import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import HarnessStack, { state } from "./fixtures/harness/stack.ts";

const HOOK_TIMEOUT = 600_000;

/**
 * `Cloudflare.Containers.Harness` keeps a session working across a
 * container restart: `stop()` snapshots the container, the next turn
 * restores it, and the session resumes with its files and conversation,
 * while its history stays in the Durable Object.
 */
describe.each([
  { dev: true, mode: "local" },
  { dev: false, mode: "live" },
])("Containers.Harness (dev: $dev)", ({ dev, mode }) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state,
    dev,
  });
  const stack = beforeAll(deploy(HarnessStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(HarnessStack), { timeout: HOOK_TIMEOUT });

  const get = (path: string, params: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const target = new URL(path, url);
      for (const [key, value] of Object.entries({ object: mode, ...params })) {
        target.searchParams.set(key, value);
      }
      return yield* client.get(target).pipe(
        Effect.flatMap((r) =>
          r.status !== 200
            ? r.text.pipe(Effect.flatMap((body) => Effect.fail(new Error(`${r.status}: ${body}`))))
            : r.text,
        ),
        Effect.timeout("150 seconds"),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 5 }),
      );
    });

  test(
    "a session keeps its files and conversation across a restart",
    Effect.gen(function* () {
      const session = "restart";
      yield* get("/turn", {
        session,
        prompt:
          "Run the shell command `echo banana-42 > /workspace/note.txt`. Remember the word 'otter'. Reply with only: done",
      });
      yield* get("/stop");

      const file = yield* get("/turn", {
        session,
        prompt: "Run `cat /workspace/note.txt` and reply with only its output.",
      });
      expect(file).toContain("banana-42");

      const recalled = yield* get("/turn", {
        session,
        prompt: "Which word did I ask you to remember? Reply with only that word.",
      });
      expect(recalled.toLowerCase()).toContain("otter");

      expect(yield* get("/turns", { session })).toBe("3");
    }),
    { tags: [mode, "provider:cloudflare", "provider:cloudflare:container"], timeout: 600_000 },
  );
});
