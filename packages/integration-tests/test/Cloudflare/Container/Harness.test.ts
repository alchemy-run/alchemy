import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import HarnessStack, { state } from "./fixtures/harness/stack.ts";

const HOOK_TIMEOUT = 600_000;

/**
 * `Cloudflare.Containers.Harness` keeps a session working across container
 * restarts: from the container's snapshot after `stop()`, and from the
 * session's checkpoints (recreating the workspace) when the container was
 * lost without one. History stays in the Durable Object either way.
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
        // A fresh workers.dev URL answers 404 for a few seconds.
        Effect.retry({ schedule: Schedule.exponential("1 second", 1.5), times: 8 }),
      );
    });

  test(
    "commands run with exec reach egress hosts over intercepted TLS",
    Effect.gen(function* () {
      expect((yield* get("/probe", { object: `${mode}-probe` })).trim()).toBe("ok");
    }),
    { tags: [mode, "provider:cloudflare", "provider:cloudflare:container"], timeout: 300_000 },
  );

  test(
    "a session keeps its files and conversation across a restart",
    Effect.gen(function* () {
      const session = "restart";
      yield* get("/turn", {
        session,
        prompt:
          "Run the shell command `echo banana-42 > /workspace/repo/note.txt`. Remember the word 'otter'. Reply with only: done",
      });
      yield* get("/stop");

      const file = yield* get("/turn", {
        session,
        prompt: "Run `cat /workspace/repo/note.txt` and reply with only its output.",
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

  test(
    "a session lost without a snapshot comes back from its checkpoint",
    Effect.gen(function* () {
      const session = "crash";
      const params = { object: `${mode}-crash`, session };
      yield* get("/turn", {
        ...params,
        prompt:
          "Run the shell commands `echo kiwi-7 > /workspace/repo/fruit.txt` and `echo old > /root/outside.txt`. Remember the word 'heron'. Reply with only: done",
      });
      expect(yield* get("/read", { ...params, path: "/root/outside.txt" })).toContain("old");
      yield* get("/crash", params);

      const files = yield* get("/turn", {
        ...params,
        prompt:
          "Run `cat /workspace/repo/fruit.txt /workspace/repo/base.txt` and reply with only the output.",
      });
      // The fresh container had no repository: the checkpoint recreated it,
      // with its history (base.txt) and the uncommitted file.
      expect(files).toContain("kiwi-7");
      expect(files).toContain("base");
      // A new container: what was outside the workspace is gone.
      expect(yield* get("/read", { ...params, path: "/root/outside.txt" })).toBe("");

      const recalled = yield* get("/turn", {
        ...params,
        prompt: "Which word did I ask you to remember? Reply with only that word.",
      });
      expect(recalled.toLowerCase()).toContain("heron");
    }),
    { tags: [mode, "provider:cloudflare", "provider:cloudflare:container"], timeout: 600_000 },
  );
});
