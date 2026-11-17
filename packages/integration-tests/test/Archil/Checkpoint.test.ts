import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Objects from "@distilled.cloud/archil/Objects";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Archil.providers() });

test.provider(
  "checkpoint seeds a disk; branches fork from it and see the seeded files",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { seed, base, branch } = yield* stack.deploy(
        Effect.gen(function* () {
          const seed = yield* Archil.Disk("Seed", {});
          const base = yield* Archil.Checkpoint("Base", {
            disk: seed.diskId,
            run: ["echo seeded > marker.txt"],
          });
          const branch = yield* Archil.Branch("Staging", {
            disk: seed.diskId,
            fromCheckpoint: base.name,
          });
          return { seed, base, branch };
        }),
      );
      expect(branch.diskId).toBe(seed.diskId);
      expect(branch.fromCheckpoint).toBe(base.name);
      const listed = (yield* archil.listBranches({ id: seed.diskId })).data;
      expect(listed.map((b) => b.branch_name)).toContain(branch.name);

      // The branch holds what the checkpoint captured; a later write on the
      // root doesn't reach it.
      yield* archil.execDisk({ id: seed.diskId, command: "echo changed > /mnt/archil/marker.txt" });
      const root = yield* Objects.getObjectText({ disk: seed.diskId }, "marker.txt").pipe(
        Effect.provide(Objects.ObjectCredentialsFromApiKey),
      );
      const forked = yield* Objects.getObjectText(
        { disk: seed.diskId, branch: branch.name },
        "marker.txt",
      ).pipe(Effect.provide(Objects.ObjectCredentialsFromApiKey));
      expect(root.trim()).toBe("changed");
      expect(forked.trim()).toBe("seeded");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:archil", "provider:archil:checkpoint", "provider:archil:branch", "live"],
    timeout: 300_000,
  },
);
