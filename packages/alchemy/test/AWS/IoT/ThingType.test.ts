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

describe.sequential("AWS.IoT.ThingType", () => {
  test.provider(
    "creates a thing type, associates a thing, and deprecates it on destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const thingType = yield* ThingType("SensorType", {
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
