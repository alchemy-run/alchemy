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

test.provider(
  "save a sandbox as a snapshot and start a sandbox from it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { snapshot, copy } = yield* stack.deploy(
        Effect.gen(function* () {
          const builder = yield* Boat.Sandbox("Builder", {
            type: "small",
            noEnv: true,
            ttlSeconds: 600,
            setupScript: "echo baked > /home/user/baked.txt",
          });
          // Boat runs the setup script in the background; the snapshot waits for it.
          const snapshot = yield* Boat.Snapshot("Golden", { sandboxId: builder.sandboxId });
          const copy = yield* Boat.Sandbox("Copy", {
            type: "small",
            noEnv: true,
            ttlSeconds: 600,
            from: snapshot.name,
          });
          return { builder, snapshot, copy };
        }),
      );
      expect(snapshot.name).toMatch(/^[a-z0-9-]+$/);
      expect((yield* observe(snapshot.name))?.status).toBe("ready");
      expect(snapshot.snapshotId).toBeDefined();

      const baked = yield* boat.executeSandboxCommand({
        sandboxId: copy.sandboxId,
        command: "cat /home/user/baked.txt",
      });
      expect("stdout" in baked ? baked.stdout.trim() : undefined).toBe("baked");

      yield* stack.destroy();
      expect(yield* observe(snapshot.name)).toBeUndefined();
    }),
  { tags, timeout: 240_000 },
);
