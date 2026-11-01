import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeDestination, observeRouter, OTLP_URI } from "./telemetry.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("telemetry", "router"), timeout: 900_000 } as const;

const filter = {
  attributes: [
    {
      key: "service.name",
      level: "resource",
      matcher: "=",
      values: ["iam"],
    },
  ],
} satisfies Stackit.Telemetry.TelemetryFilter;

test.provider(
  "create, update and delete a router",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        description: "alchemy test router",
        labels: { env: "test", keep: "yes" },
      };
      const created = yield* stack.deploy(Stackit.Telemetry.Router("BasicRouter", props));
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.status).toEqual("active");
      expect(created.displayName.length).toBeLessThanOrEqual(32);
      expect(created.labels).toEqual({ env: "test", keep: "yes" });

      // Out of band: it exists, with Alchemy's ownership labels.
      const fetched = yield* router.getTelemetryRouter({
        projectId,
        regionId: region,
        telemetryRouterId: created.routerId,
      });
      expect(fetched.description).toEqual("alchemy test router");
      expect(fetched.resourceLabels).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "BasicRouter",
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Telemetry.Router("BasicRouter", props));
      expect(plan.resources.BasicRouter).toMatchObject({ action: "noop" });

      // Every mutable aspect updates in place.
      const updated = yield* stack.deploy(
        Stackit.Telemetry.Router("BasicRouter", {
          displayName: "alchemy-test-router",
          description: "alchemy test router updated",
          filter,
          labels: { env: "prod" },
        }),
      );
      expect(updated.routerId).toEqual(created.routerId);
      expect(updated.displayName).toEqual("alchemy-test-router");

      const afterUpdate = yield* router.getTelemetryRouter({
        projectId,
        regionId: region,
        telemetryRouterId: created.routerId,
      });
      expect(afterUpdate.displayName).toEqual("alchemy-test-router");
      expect(afterUpdate.description).toEqual("alchemy test router updated");
      expect(afterUpdate.filter?.attributes).toEqual(filter.attributes);
      expect(afterUpdate.resourceLabels?.env).toEqual("prod");
      expect(afterUpdate.resourceLabels?.keep).toBeUndefined();

      yield* stack.destroy();
      yield* expectGone(observeRouter(projectId, region, created.routerId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "moving a router to another region replaces it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Stackit.Telemetry.Router("MovedRouter", { region: "eu01" }),
      );
      const second = yield* stack.deploy(
        Stackit.Telemetry.Router("MovedRouter", { region: "eu02" }),
      );
      expect(second.routerId).not.toEqual(first.routerId);
      expect(second.region).toEqual("eu02");
      yield* expectGone(observeRouter(projectId, "eu01", first.routerId));

      yield* stack.destroy();
      yield* expectGone(observeRouter(projectId, "eu02", second.routerId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a router of the same name without labels is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      const displayName = "alchemy-test-foreign";

      // It has no labels for `pnpm nuke` to find, so it goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        router.createTelemetryRouter({ projectId, regionId: region, displayName }),
        (foreign) =>
          Effect.gen(function* () {
            const error = yield* stack
              .deploy(Stackit.Telemetry.Router("ForeignRouter", { displayName }))
              .pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");

            // The foreign router is untouched, and the failed deploy created nothing else.
            const after = yield* router.getTelemetryRouter({
              projectId,
              regionId: region,
              telemetryRouterId: foreign.id,
            });
            expect(after.resourceLabels?.["alchemy.id"]).toBeUndefined();
          }),
        (foreign) =>
          router
            .deleteTelemetryRouter({
              projectId,
              regionId: region,
              telemetryRouterId: foreign.id,
            })
            .pipe(
              Effect.andThen(expectGone(observeRouter(projectId, region, foreign.id))),
              Effect.ignore,
            ),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a destination made out of band stops the destroy, before the router is stuck deleting",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { routerId } = yield* stack.deploy(Stackit.Telemetry.Router("GuardedRouter", {}));
      const foreign = yield* router.createDestination({
        projectId,
        regionId: region,
        telemetryRouterId: routerId,
        displayName: "alchemy-test-hand-made",
        config: {
          configType: "OpenTelemetry",
          openTelemetry: { uri: OTLP_URI, bearerToken: "alchemy-test-token" },
        },
      });

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.Telemetry.RouterNotEmpty",
        children: ["destination alchemy-test-hand-made"],
      });
      // The delete was never sent, so the router isn't on its way out.
      const live = yield* observeRouter(projectId, region, routerId);
      expect(live).toMatchObject({ status: "active" });

      yield* router.deleteDestination({
        projectId,
        regionId: region,
        telemetryRouterId: routerId,
        destinationId: foreign.id,
      });
      yield* expectGone(observeDestination(projectId, region, routerId, foreign.id));
      yield* stack.destroy();
      yield* expectGone(observeRouter(projectId, region, routerId));
    }).pipe(logLevel),
  options,
);
