import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import Stack, { providers, state } from "./fixtures/stack.ts";

/**
 * `FS.MountFile` and `FS.MountFolder` in one container, built locally
 * (`dev: true`). The container reports what landed on disk.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state, dev: true });

const HOOK_TIMEOUT = 600_000;

describe("FS mounts in a container", { tags: ["local"] }, () => {
  const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: HOOK_TIMEOUT });

  test(
    "files and folders land at their paths",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const client = yield* HttpClient.HttpClient;
      const text = yield* client.get(`${url}/check`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.text
            : res.text.pipe(Effect.flatMap((body) => Effect.fail(new Error(body)))),
        ),
        // The first request waits for the container to build and boot.
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
      );
      yield* Effect.log(`/check output:\n${text}`);
      const facts = Object.fromEntries(
        text
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );

      expect(facts.file, text).toBe('{"model":"haiku"}');
      expect(facts.script).toBe("hi");
      expect(facts.folder).toBe("from the folder|nested file");
    }),
    { timeout: 300_000 },
  );
});
