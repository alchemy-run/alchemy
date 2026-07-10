import * as AWS from "@/AWS";
import * as Location from "@/AWS/Location";
import * as Test from "@/Test/Vitest";
import * as location from "@distilled.cloud/aws/location";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Bounded wait-until-gone: a Describe on a deleted Location resource returns a
// typed ResourceNotFoundException. Poll a few times so the assertion tolerates
// the brief eventual-consistency window after Delete.
const assertGone = <R>(probe: Effect.Effect<unknown, { _tag: string }, R>) =>
  probe.pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "StillExists" as const })),
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "StillExists",
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

describe.skipIf(!!process.env.FAST)("AWS.Location", () => {
  test.provider(
    "Map: create, update description, delete",
    (stack) =>
      Effect.gen(function* () {
        const map = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Map("TestMap", {
              configuration: { style: "VectorEsriNavigation" },
              tags: { Environment: "test" },
            });
          }),
        );

        expect(map.mapName).toBeDefined();
        expect(map.mapArn).toContain(":map/");
        expect(map.style).toEqual("VectorEsriNavigation");

        const described = yield* location.describeMap({
          MapName: map.mapName,
        });
        expect(described.Configuration.Style).toEqual("VectorEsriNavigation");
        expect(described.Tags?.Environment).toEqual("test");
        expect(described.Tags?.["alchemy::id"]).toEqual("TestMap");

        // Update the description in place (no replacement).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Map("TestMap", {
              configuration: { style: "VectorEsriNavigation" },
              description: "updated map",
              tags: { Environment: "prod" },
            });
          }),
        );
        expect(updated.mapName).toEqual(map.mapName);
        expect(updated.description).toEqual("updated map");
        expect(updated.tags.Environment).toEqual("prod");

        yield* stack.destroy();
        yield* assertGone(location.describeMap({ MapName: map.mapName }));
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "PlaceIndex: create, update, delete",
    (stack) =>
      Effect.gen(function* () {
        const index = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.PlaceIndex("TestIndex", {
              dataSource: "Esri",
            });
          }),
        );

        expect(index.indexArn).toContain(":place-index/");
        expect(index.dataSource).toEqual("Esri");

        const described = yield* location.describePlaceIndex({
          IndexName: index.indexName,
        });
        expect(described.DataSource).toEqual("Esri");
        expect(described.Tags?.["alchemy::id"]).toEqual("TestIndex");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.PlaceIndex("TestIndex", {
              dataSource: "Esri",
              description: "updated index",
            });
          }),
        );
        expect(updated.indexName).toEqual(index.indexName);
        expect(updated.description).toEqual("updated index");

        yield* stack.destroy();
        yield* assertGone(
          location.describePlaceIndex({ IndexName: index.indexName }),
        );
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "RouteCalculator: create and delete",
    (stack) =>
      Effect.gen(function* () {
        const calc = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.RouteCalculator("TestCalc", {
              dataSource: "Esri",
            });
          }),
        );

        expect(calc.calculatorArn).toContain(":route-calculator/");
        expect(calc.dataSource).toEqual("Esri");

        const described = yield* location.describeRouteCalculator({
          CalculatorName: calc.calculatorName,
        });
        expect(described.DataSource).toEqual("Esri");
        expect(described.Tags?.["alchemy::id"]).toEqual("TestCalc");

        yield* stack.destroy();
        yield* assertGone(
          location.describeRouteCalculator({
            CalculatorName: calc.calculatorName,
          }),
        );
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "GeofenceCollection: create, update, delete",
    (stack) =>
      Effect.gen(function* () {
        const collection = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.GeofenceCollection("TestFences", {});
          }),
        );

        expect(collection.collectionArn).toContain(":geofence-collection/");

        const described = yield* location.describeGeofenceCollection({
          CollectionName: collection.collectionName,
        });
        expect(described.Tags?.["alchemy::id"]).toEqual("TestFences");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.GeofenceCollection("TestFences", {
              description: "updated fences",
            });
          }),
        );
        expect(updated.collectionName).toEqual(collection.collectionName);
        expect(updated.description).toEqual("updated fences");

        yield* stack.destroy();
        yield* assertGone(
          location.describeGeofenceCollection({
            CollectionName: collection.collectionName,
          }),
        );
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "Tracker: create, update filtering, delete",
    (stack) =>
      Effect.gen(function* () {
        const tracker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Tracker("TestTracker", {});
          }),
        );

        expect(tracker.trackerArn).toContain(":tracker/");
        expect(tracker.positionFiltering).toEqual("TimeBased");

        const described = yield* location.describeTracker({
          TrackerName: tracker.trackerName,
        });
        expect(described.Tags?.["alchemy::id"]).toEqual("TestTracker");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Location.Tracker("TestTracker", {
              positionFiltering: "DistanceBased",
              description: "fleet tracker",
            });
          }),
        );
        expect(updated.trackerName).toEqual(tracker.trackerName);
        expect(updated.positionFiltering).toEqual("DistanceBased");
        expect(updated.description).toEqual("fleet tracker");

        yield* stack.destroy();
        yield* assertGone(
          location.describeTracker({ TrackerName: tracker.trackerName }),
        );
      }),
    { timeout: 180_000 },
  );
});
