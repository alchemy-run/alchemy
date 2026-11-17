import * as Daytona from "@alchemy.run/daytona";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as volumes from "@distilled.cloud/daytona/volumes";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Daytona.providers() });

const tags = ["provider:daytona", "provider:daytona:volume", "provider:daytona:sandbox", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Daytona.providers() }, "DaytonaLookupTarget");

describe.sequential("lookup", () => {
  test.provider(
    "a Sandbox mounts a looked-up Volume, which survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const volume = yield* owner.deploy(Daytona.Volume("LookupTarget", {}));

        const program = Daytona.Sandbox("OnLookedUpVolume", {
          mounts: [
            { volume: Daytona.Volume.lookup({ name: volume.name }), path: "/home/daytona/data" },
          ],
        });
        const box = yield* stack.deploy(program);
        const observed = yield* sandboxes.getSandbox({ sandboxIdOrName: box.sandboxId });
        expect(observed.volumes?.map((v) => v.volumeId)).toContain(volume.volumeId);

        // A lookup re-resolves to the same Volume.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpVolume?.action).toEqual("noop");

        // Destroying the consumer removes the Sandbox, never the Volume.
        yield* stack.destroy();
        const after = yield* volumes.getVolume({ volumeId: volume.volumeId });
        expect(after.id).toEqual(volume.volumeId);

        yield* owner.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const missing = "alchemy-lookup-missing";
        const lookups = {
          Snapshot: Daytona.Snapshot.lookup({ name: missing }),
          Volume: Daytona.Volume.lookup({ name: missing }),
          Registry: Daytona.Registry.lookup({ name: missing }),
          Sandbox: Daytona.Sandbox.lookup({ name: missing }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(
              Daytona.Registry(id, {
                url: "ghcr.io",
                username: "lookup-probe",
                password: Redacted.make("lookup-probe"),
                project: Output.interpolate`${lookup}`,
              }),
            ),
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
