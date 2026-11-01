import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as iaas from "@distilled.cloud/stackit/iaas";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, GONE, PRESENT } from "./compute.ts";

const { test } = makeStackitTest();

// Volumes are billed per GB-hour; a 1-2 GB volume held for a few minutes
// costs a fraction of a cent, so the suite is ungated.
const options = { tags: stackitTags("iaas", "volume"), timeout: 600_000 } as const;

const presence = (projectId: string, region: string, volumeId: string) =>
  iaas.getVolume({ projectId, region, volumeId }).pipe(
    Effect.as(PRESENT),
    Effect.catchTag("NotFound", () => Effect.succeed(GONE)),
  );

test.provider(
  "create, update, grow, replace and delete a volume",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const zone1 = `${region}-1`;
      const zone2 = `${region}-2`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.IaaS.Volume("Data", {
          size: 1,
          availabilityZone: zone1,
          description: "first",
          labels: { env: "test" },
        }),
      );
      expect(created.volumeId).toEqual(expect.any(String));
      expect(created.size).toEqual(1);
      expect(created.availabilityZone).toEqual(zone1);
      expect(created.status).toEqual("AVAILABLE");
      expect(created.labels).toEqual({ env: "test" });

      const fetched = yield* iaas.getVolume({ projectId, region, volumeId: created.volumeId });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("first");
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({ "alchemy.id": "Data" });

      // Description, labels and a larger size update in place.
      const updated = yield* stack.deploy(
        Stackit.IaaS.Volume("Data", {
          size: 2,
          availabilityZone: zone1,
          description: "second",
          labels: { env: "prod" },
        }),
      );
      expect(updated.volumeId).toEqual(created.volumeId);
      expect(updated.size).toEqual(2);
      const refetched = yield* iaas.getVolume({ projectId, region, volumeId: created.volumeId });
      expect(refetched.size).toEqual(2);
      expect(refetched.description).toEqual("second");
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // A different availability zone replaces the volume.
      const moved = yield* stack.deploy(
        Stackit.IaaS.Volume("Data", {
          size: 2,
          availabilityZone: zone2,
          description: "second",
          labels: { env: "prod" },
        }),
      );
      expect(moved.volumeId).not.toEqual(created.volumeId);
      expect(moved.availabilityZone).toEqual(zone2);
      yield* expectGone(presence(projectId, region, created.volumeId));

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, moved.volumeId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "replacing a volume with an explicit name creates a new one and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const name = "alchemy-iaas-volume-explicit";
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.IaaS.Volume("Explicit", { name, size: 2 }));
      expect(created.name).toEqual(name);

      const shrunk = yield* stack.deploy(Stackit.IaaS.Volume("Explicit", { name, size: 1 }));
      expect(shrunk.volumeId).not.toEqual(created.volumeId);
      expect(shrunk.name).toEqual(name);
      expect(shrunk.size).toEqual(1);
      yield* expectGone(presence(projectId, region, created.volumeId));
      expect(yield* presence(projectId, region, shrunk.volumeId)).toEqual(PRESENT);

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, shrunk.volumeId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "shrinking a volume replaces it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.IaaS.Volume("Shrink", { size: 2 }));
      expect(created.size).toEqual(2);
      expect(created.availabilityZone).toEqual(`${region}-1`);

      const shrunk = yield* stack.deploy(Stackit.IaaS.Volume("Shrink", { size: 1 }));
      expect(shrunk.volumeId).not.toEqual(created.volumeId);
      expect(shrunk.size).toEqual(1);
      yield* expectGone(presence(projectId, region, created.volumeId));

      yield* stack.destroy();
      yield* expectGone(presence(projectId, region, shrunk.volumeId));
    }).pipe(logLevel),
  options,
);
