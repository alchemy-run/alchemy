import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Archil.providers() });

const observe = (id: string) =>
  archil.getDisk({ id }).pipe(
    Effect.map(({ data }) => (data.status === "deleted" ? undefined : data)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

test.provider(
  "disk is created, its mount settings update in place, and it is deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const disk = yield* stack.deploy(Archil.Disk("Data", {}));
      yield* expectFound(Archil.Disk.lookup({ name: disk.name }), disk);
      expect(disk.diskId).toMatch(/^dsk-/);
      expect(disk.storageType).toBe("archil");
      expect(disk.allowedIps).toEqual([]);
      expect(disk.allowSandboxMount).toBe(true);
      expect((yield* observe(disk.diskId))?.status).toBe("available");

      // Mount settings converge in place; the disk keeps its id.
      const updated = yield* stack.deploy(
        Archil.Disk("Data", { allowedIps: ["203.0.113.0/24"], allowSandboxMount: false }),
      );
      expect(updated.diskId).toBe(disk.diskId);
      const ips = yield* archil.getAllowedIps({ id: disk.diskId });
      expect(ips.data.allowedIps).toEqual(["203.0.113.0/24"]);
      const mount = yield* archil.getSandboxMount({ id: disk.diskId });
      expect(mount.data.allowSandboxMount).toBe(false);

      // Back to the defaults.
      yield* stack.deploy(Archil.Disk("Data", {}));
      expect((yield* archil.getAllowedIps({ id: disk.diskId })).data.allowedIps).toEqual([]);

      yield* stack.destroy();
      expect(yield* observe(disk.diskId)).toBeUndefined();
    }),
  { tags: ["provider:archil", "provider:archil:disk", "live"], timeout: 180_000 },
);

test.provider(
  "renaming a disk replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const stage = yield* Stage;
      const first = yield* stack.deploy(Archil.Disk("Named", { name: `alchemy-${stage}-disk-a` }));
      const second = yield* stack.deploy(Archil.Disk("Named", { name: `alchemy-${stage}-disk-b` }));
      expect(second.diskId).not.toBe(first.diskId);
      expect(second.name).toBe(`alchemy-${stage}-disk-b`);
      expect(yield* observe(first.diskId)).toBeUndefined();
      yield* stack.destroy();
      expect(yield* observe(second.diskId)).toBeUndefined();
    }),
  { tags: ["provider:archil", "provider:archil:disk", "live"], timeout: 180_000 },
);
