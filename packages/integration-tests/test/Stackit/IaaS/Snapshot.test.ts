import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, GONE, PRESENT } from "./compute.ts";

const { test } = makeStackitTest();

// A snapshot of a 1 GB volume is billed per GB-hour (fractions of a cent
// for this suite), so it is ungated.
const options = { tags: stackitTags("iaas", "snapshot"), timeout: 600_000 } as const;

const presence = (projectId: string, region: string, snapshotId: string) =>
  iaas.getSnapshot({ projectId, region, snapshotId }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

// Both volumes stay deployed across steps so a replacement never removes
// the dependency it is moving away from.
const snapshotOf = (source: "A" | "B", description: string, labels: Record<string, string>) =>
  Effect.gen(function* () {
    const a = yield* Stackit.IaaS.Volume("SnapVolumeA", { size: 1 });
    const b = yield* Stackit.IaaS.Volume("SnapVolumeB", { size: 1 });
    const snapshot = yield* Stackit.IaaS.Snapshot("Snap", {
      volumeId: source === "A" ? a.volumeId : b.volumeId,
      description,
      labels,
    });
    return { a, b, snapshot };
  });

test.provider(
  "take, update, replace and delete a snapshot",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(snapshotOf("A", "first", { env: "test" }));
      expect(created.snapshot.snapshotId).toEqual(expect.any(String));
      expect(created.snapshot.volumeId).toEqual(created.a.volumeId);
      expect(created.snapshot.status).toEqual("AVAILABLE");

      const fetched = yield* iaas.getSnapshot({
        projectId,
        region,
        snapshotId: created.snapshot.snapshotId,
      });
      expect(fetched.volumeId).toEqual(created.a.volumeId);
      expect(fetched.description).toEqual("first");
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({ "alchemy.id": "Snap" });

      // Description and labels update in place.
      const updated = yield* stack.deploy(snapshotOf("A", "second", { env: "prod" }));
      expect(updated.snapshot.snapshotId).toEqual(created.snapshot.snapshotId);
      const refetched = yield* iaas.getSnapshot({
        projectId,
        region,
        snapshotId: created.snapshot.snapshotId,
      });
      expect(refetched.description).toEqual("second");
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // A different volume replaces the snapshot.
      const replaced = yield* stack.deploy(snapshotOf("B", "second", { env: "prod" }));
      expect(replaced.snapshot.snapshotId).not.toEqual(created.snapshot.snapshotId);
      expect(replaced.snapshot.volumeId).toEqual(replaced.b.volumeId);
      yield* expectGone(presence(projectId, region, created.snapshot.snapshotId));

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, replaced.snapshot.snapshotId));
    }).pipe(logLevel),
  options,
);
