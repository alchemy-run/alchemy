import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Boat.providers() });

const tags = ["provider:boat", "provider:boat:snapshot", "live"];

const observe = (name: string) =>
  boat.getSavedSnapshot({ name }).pipe(
    Effect.map((got): boat.SavedSnapshot | undefined => got.snapshot),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** The sandboxes one test's stack owns: its own stack name and stage. */
const sandboxesOf = (stack: { readonly name: string; readonly stage: string }) =>
  boat
    .listSandboxes({ label: [`alchemy.stack=${stack.name}`, `alchemy.stage=${stack.stage}`] })
    .pipe(Effect.map((listed) => listed.sandboxes.map((sandbox) => sandbox.id)));

test.provider(
  "build a snapshot from commands, start a sandbox from it, and replace the sandbox on a rebuild",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (contents: string) =>
        Effect.gen(function* () {
          const Golden = Boat.Snapshot("Golden", {
            type: "small",
            run: [`echo ${contents} > /home/user/baked.txt`],
          });
          const copy = yield* Boat.Sandbox("Copy", {
            type: "small",
            noEnv: true,
            autoStop: "10 minutes",
            snapshot: Golden,
          });
          return { golden: yield* Golden, copy };
        });

      const first = yield* stack.deploy(program("baked"));
      expect(first.golden.name).toMatch(/^[a-z0-9-]+$/);
      expect((yield* observe(first.golden.name))?.status).toBe("ready");
      const baked = yield* boat.executeSandboxCommand({
        sandboxId: first.copy.sandboxId,
        command: "cat /home/user/baked.txt",
      });
      expect("stdout" in baked ? baked.stdout.trim() : undefined).toBe("baked");
      // The setup sandbox is deleted once the snapshot is saved.
      expect(yield* sandboxesOf(stack)).toEqual([first.copy.sandboxId]);

      // An unchanged redeploy plans nothing.
      const plan = yield* stack.plan(program("baked"));
      expect(plan.resources.Golden.action).toBe("noop");
      expect(plan.resources.Copy.action).toBe("noop");

      // New commands re-save the snapshot, and the sandbox started from it is replaced.
      const second = yield* stack.deploy(program("rebaked"));
      expect(second.golden.name).toBe(first.golden.name);
      expect(second.golden.setupHash).not.toBe(first.golden.setupHash);
      expect(second.copy.sandboxId).not.toBe(first.copy.sandboxId);
      const rebaked = yield* boat.executeSandboxCommand({
        sandboxId: second.copy.sandboxId,
        command: "cat /home/user/baked.txt",
      });
      expect("stdout" in rebaked ? rebaked.stdout.trim() : undefined).toBe("rebaked");

      yield* stack.destroy();
      expect(yield* observe(first.golden.name)).toBeUndefined();
      expect(yield* sandboxesOf(stack)).toEqual([]);
    }),
  { tags, timeout: 600_000 },
);

test.provider(
  "a failing setup command fails the deploy and deletes its setup sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const failed = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Boat.Snapshot("Broken", { type: "small", run: ["exit 7"] });
          }),
        )
        .pipe(Effect.flip);
      expect(String(failed)).toContain("exited with 7");
      expect(yield* sandboxesOf(stack)).toEqual([]);

      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
