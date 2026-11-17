import * as Archil from "@alchemy.run/archil";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as archil from "@distilled.cloud/archil";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Archil.providers() });

const tags = ["provider:archil", "provider:archil:disk", "provider:archil:branch", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Archil.providers() }, "ArchilLookupTarget");

describe.sequential("lookup", () => {
  test.provider(
    "a looked-up Disk holds a declared Branch and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const disk = yield* owner.deploy(Archil.Disk("LookupTarget", {}));

        const program = Effect.gen(function* () {
          const looked = Archil.Disk.lookup({ name: disk.name });
          const base = yield* Archil.Checkpoint("Base", { disk: looked.diskId, run: ["true"] });
          return yield* Archil.Branch("OnLookedUpDisk", {
            disk: looked.diskId,
            fromCheckpoint: base.name,
          });
        });
        const branch = yield* stack.deploy(program);
        expect(branch.diskId).toEqual(disk.diskId);

        // A lookup re-resolves to the same Disk.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpDisk?.action).toEqual("noop");

        // Destroying the consumer removes the Branch, never the Disk.
        yield* stack.destroy();
        const after = yield* archil.getDisk({ id: disk.diskId });
        expect(after.data.id).toEqual(disk.diskId);

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const lookups = {
          Disk: Archil.Disk.lookup({ name: "alchemy-lookup-missing" }),
          Image: Archil.Image.lookup({ imageId: "alchemy-lookup-missing" }),
          Sandbox: Archil.Sandbox.lookup({ name: "alchemy-lookup-missing" }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(Archil.Disk(id, { allowedIps: [Output.interpolate`${lookup}`] })),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});
      }),
    { tags, timeout: 120_000 },
  );
});
