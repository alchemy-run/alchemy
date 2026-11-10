import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as volumes from "@distilled.cloud/daytona/volumes";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Daytona.providers() });

const state = (volumeId: string) =>
  volumes.getVolume({ volumeId }).pipe(
    Effect.map((v) => v.state),
    Effect.catchTag("VolumeNotFound", () => Effect.succeed("deleted" as const)),
  );

// Deletion is asynchronous: the volume sits in pending_delete for a few seconds.
const deleted = (volumeId: string) =>
  state(volumeId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (s) => s === "deleted",
      times: 20,
    }),
  );

test.provider(
  "create a volume, keep it on redeploy, replace it on rename, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(Daytona.Volume("Data", {}));
      yield* expectFound(Daytona.Volume.lookup({ name: created.name }), created);
      expect(created.state).toEqual("ready");
      expect(yield* state(created.volumeId)).toEqual("ready");

      const again = yield* stack.deploy(Daytona.Volume("Data", {}));
      expect(again.volumeId).toEqual(created.volumeId);

      const renamed = yield* stack.deploy(
        Daytona.Volume("Data", { name: `${created.name}-renamed` }),
      );
      expect(renamed.volumeId).not.toEqual(created.volumeId);
      expect(yield* deleted(created.volumeId)).toEqual("deleted");

      yield* stack.destroy();
      expect(yield* deleted(renamed.volumeId)).toEqual("deleted");
    }),
  { tags: ["provider:daytona", "live"], timeout: 180_000 },
);
