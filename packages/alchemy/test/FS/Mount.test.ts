import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Test from "@/Test/Alchemy";
import Stack, { providers, state } from "./fixtures/stack.ts";

/**
 * Every mount kind in one container, built locally (`dev: true`):
 * `FS.MountFile`, `FS.MountFolder`, `GitHub.MountRepository` (read and
 * write access, with a token or an automatic deploy key), `Git.MountRepository` (a repository on a local Alchemy
 * Git service) and `Cloudflare.Artifacts.MountRepository` (a real Artifacts
 * repository — run with `--profile testing`). The container reports what landed on disk and what git may
 * do with each checkout.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state, dev: true });

const HOOK_TIMEOUT = 600_000;

describe("FS and git mounts in a container", { tags: ["local"] }, () => {
  const stack = beforeAll(deploy(Stack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: HOOK_TIMEOUT });

  test(
    "files, folders and repositories land at their paths with the requested git access",
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

      // Read access: fetch credentials, push disabled.
      expect(facts["hello-ro.readme"]).toBe("Hello World!");
      expect(facts["hello-ro.branch"]).toBe("master");
      expect(facts["hello-ro.upstream"]).toBe("origin/master");
      expect(facts["hello-ro.pushurl"]).toBe("DISABLED");
      expect(facts["hello-ro.cred"]).toBe("read-token");

      // Write access: credentials and a real push URL.
      expect(facts["hello-rw.pushurl"]).toBe("https://github.com/octocat/Hello-World.git");
      expect(facts["hello-rw.cred"]).toBe("write-token");

      // A repository on the Alchemy Git service.
      expect(facts["docs.readme"]).toBe("Hello World!");
      expect(facts["docs.pushurl"]).toMatch(/\/e2e\/.+\.git$/);
      expect(facts["docs.cred"]).not.toBe("");

      // A private GitHub repository mounted without a token: git uses the
      // deploy key the mount created, over SSH, for fetch and push.
      expect(facts["agent.readme"]).toBe("# test-mount-deploy-key");
      expect(facts["agent.lsremote"]).toBe("ok");
      expect(facts["agent.push"]).toBe("ok");

      // A Cloudflare Artifacts repository, with a minted read token.
      expect(facts["scratch.readme"]).toBe("Hello World!");
      expect(facts["scratch.pushurl"]).toBe("DISABLED");
      expect(facts["scratch.cred"]).toMatch(/^art_/);
    }),
    { timeout: 300_000 },
  );
});
