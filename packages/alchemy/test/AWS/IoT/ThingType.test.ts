import * as AWS from "@/AWS";
import { Thing, ThingType } from "@/AWS/IoT";
import * as Test from "@/Test/Vitest";
import * as iot from "@distilled.cloud/aws/iot";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const assertThingGone = (thingName: string) =>
  iot.describeThing({ thingName }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`thing ${thingName} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

// AWS enforces a mandatory 5-minute window between deprecating a thing type
// and deleting it, so `stack.destroy()` can only leave the type deprecated
// (like KMS keys pending deletion). A generated physical name would mint a
// fresh random suffix every run and strand one permanently-orphaned
// deprecated type per run — so the name is a deterministic constant, and
// each run pre-cleans the previous run's deprecated leftover (deletable once
// its 5-minute window has passed). Worst-case residue is exactly one
// deprecated thing type with this name, reaped by the next run.
const testThingTypeName = "alchemy-test-iot-thing-type";

describe.sequential("AWS.IoT.ThingType", () => {
  test.provider(
    "creates a thing type, associates a thing, and deprecates it on destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Pre-clean: delete the previous run's deprecated leftover. Inside
        // the 5-minute window AWS rejects with InvalidRequestException — in
        // that case reconcile un-deprecates and reuses the existing type.
        yield* iot
          .deleteThingType({ thingTypeName: testThingTypeName })
          .pipe(
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidRequestException"],
              () => Effect.void,
            ),
          );

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const thingType = yield* ThingType("SensorType", {
              thingTypeName: testThingTypeName,
              description: "Alchemy IoT test sensors",
              searchableAttributes: ["location"],
              tags: { purpose: "alchemy-test" },
            });
            const thing = yield* Thing("TypedSensor", {
              thingTypeName: thingType.thingTypeName,
              attributes: { location: "warehouse-a" },
            });
            return {
              thingTypeName: thingType.thingTypeName,
              thingTypeArn: thingType.thingTypeArn,
              thingName: thing.thingName,
            };
          }),
        );

        // Verify out-of-band: the type exists, is active (a previous run's
        // destroy leaves it deprecated — reconcile must un-deprecate), and the
        // thing is associated with it.
        const observed = yield* iot.describeThingType({
          thingTypeName: created.thingTypeName,
        });
        expect(observed.thingTypeArn).toEqual(created.thingTypeArn);
        expect(observed.thingTypeProperties?.thingTypeDescription).toEqual(
          "Alchemy IoT test sensors",
        );
        expect(observed.thingTypeProperties?.searchableAttributes).toEqual([
          "location",
        ]);
        expect(observed.thingTypeMetadata?.deprecated ?? false).toBe(false);

        const thing = yield* iot.describeThing({
          thingName: created.thingName,
        });
        expect(thing.thingTypeName).toEqual(created.thingTypeName);

        yield* stack.destroy();
        yield* assertThingGone(created.thingName);

        // AWS enforces a 5-minute window between deprecation and deletion, so
        // destroy cannot delete the type immediately — it deprecates it and
        // tolerates the rejected delete. Assert the deprecated end state.
        const afterDestroy = yield* iot.describeThingType({
          thingTypeName: created.thingTypeName,
        });
        expect(afterDestroy.thingTypeMetadata?.deprecated).toBe(true);
      }),
    { timeout: 180_000 },
  );
});
