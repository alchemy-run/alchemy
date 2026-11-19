import * as Archil from "@alchemy.run/archil";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as archil from "@distilled.cloud/archil";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Archil.providers() });

test.provider(
  "branch is created from a checkpoint and a new name creates a new branch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = (name?: string) =>
        Effect.gen(function* () {
          const seed = yield* Archil.Disk("Seed", {});
          const base = yield* Archil.Checkpoint("Base", { disk: seed.diskId, run: ["true"] });
          const branch = yield* Archil.Branch("Feature", {
            disk: seed.diskId,
            name,
            fromCheckpoint: base.name,
          });
          return { seed, branch };
        });
      const { seed, branch } = yield* stack.deploy(app());
      yield* expectFound(Archil.Branch.lookup({ disk: seed.diskId, name: branch.name }), branch);
      const renamed = yield* stack.deploy(app("feature-2"));
      expect(renamed.branch.name).toBe("feature-2");
      expect(renamed.branch.filesystemId).not.toBe(branch.filesystemId);
      const names = (yield* archil.listBranches({ id: seed.diskId })).data.map(
        (b) => b.branch_name,
      );
      expect(names).toEqual(expect.arrayContaining([branch.name, "feature-2"]));
      yield* stack.destroy();
    }),
  { tags: ["provider:archil", "provider:archil:branch", "live"], timeout: 300_000 },
);
