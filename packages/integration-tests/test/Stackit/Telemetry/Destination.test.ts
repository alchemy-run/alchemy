import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as router from "@distilled.cloud/stackit/telemetry_router";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeDestination, observeRouter, OTLP_URI } from "./telemetry.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("telemetry", "destination"), timeout: 900_000 } as const;

/** The router, plus the destination when `destination` is given. */
const app = (destination?: Omit<Stackit.Telemetry.DestinationProps, "routerId">) =>
  Effect.gen(function* () {
    const parent = yield* Stackit.Telemetry.Router("DestinationRouter", {});
    if (destination === undefined) return { router: parent, destination: undefined };
    return {
      router: parent,
      destination: yield* Stackit.Telemetry.Destination("DestinationUnderTest", {
        routerId: parent.routerId,
        ...destination,
      }),
    };
  });

test.provider(
  "create, update and delete an OpenTelemetry destination",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        description: "alchemy test destination",
        config: {
          type: "OpenTelemetry",
          uri: OTLP_URI,
          bearerToken: Redacted.make("alchemy-test-token"),
        },
      } satisfies Omit<Stackit.Telemetry.DestinationProps, "routerId">;
      const created = yield* stack.deploy(app(props));
      const destination = created.destination!;
      const routerId = created.router.routerId;
      expect(destination.routerId).toEqual(routerId);
      expect(destination.status).toEqual("active");
      expect(destination.credentialType).toEqual("bearerToken");
      expect(destination.config.uri).toEqual(OTLP_URI);

      // Out of band.
      const fetched = yield* router.getDestination({
        projectId,
        regionId: region,
        telemetryRouterId: routerId,
        destinationId: destination.destinationId,
      });
      expect(fetched.config.configType).toEqual("OpenTelemetry");
      expect(fetched.config.openTelemetry?.uri).toEqual(OTLP_URI);
      expect(fetched.description).toEqual("alchemy test destination");

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.DestinationUnderTest).toMatchObject({ action: "noop" });

      // A new secret alone is an update.
      const rotation = yield* stack.plan(
        app({
          ...props,
          config: { ...props.config, bearerToken: Redacted.make("alchemy-test-token-2") },
        }),
      );
      expect(rotation.resources.DestinationUnderTest).toMatchObject({ action: "update" });

      // The name, the description and the endpoint update in place.
      const updated = yield* stack.deploy(
        app({
          displayName: "alchemy-test-destination",
          description: "alchemy test destination updated",
          config: {
            type: "OpenTelemetry",
            uri: `${OTLP_URI}/updated`,
            basicAuth: { username: "alchemy", password: Redacted.make("alchemy-test-password") },
          },
        }),
      );
      expect(updated.destination!.destinationId).toEqual(destination.destinationId);
      expect(updated.destination!.displayName).toEqual("alchemy-test-destination");

      const afterUpdate = yield* router.getDestination({
        projectId,
        regionId: region,
        telemetryRouterId: routerId,
        destinationId: destination.destinationId,
      });
      expect(afterUpdate.displayName).toEqual("alchemy-test-destination");
      expect(afterUpdate.config.openTelemetry?.uri).toEqual(`${OTLP_URI}/updated`);
      expect(afterUpdate.config.openTelemetry?.basicAuth?.username).toEqual("alchemy");
      expect(afterUpdate.credentialType).toEqual("basicAuth");

      yield* stack.destroy();
      yield* expectGone(observeDestination(projectId, region, routerId, destination.destinationId));
      yield* expectGone(observeRouter(projectId, region, routerId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "switching a destination from OpenTelemetry to S3 updates in place",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        app({
          config: {
            type: "OpenTelemetry",
            uri: OTLP_URI,
            bearerToken: Redacted.make("alchemy-test-token"),
          },
        }),
      );
      const switched = yield* stack.deploy(
        app({
          config: {
            type: "S3",
            endpoint: "https://object.storage.eu01.onstackit.cloud",
            bucket: "alchemy-test-audit",
            accessKey: { id: "ALCHEMYTEST", secret: Redacted.make("alchemy-test-secret") },
          },
        }),
      );
      expect(switched.destination!.destinationId).toEqual(created.destination!.destinationId);

      const fetched = yield* router.getDestination({
        projectId,
        regionId: region,
        telemetryRouterId: created.router.routerId,
        destinationId: created.destination!.destinationId,
      });
      expect(fetched.config.configType).toEqual("S3");
      expect(fetched.config.s3?.bucket).toEqual("alchemy-test-audit");

      yield* stack.destroy();
      yield* expectGone(observeRouter(projectId, region, created.router.routerId));
    }).pipe(logLevel),
  options,
);

test.provider(
  "a destination of the same name without state is refused without --adopt",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();
      const displayName = "alchemy-test-foreign";

      const parent = yield* stack.deploy(app());
      const telemetryRouterId = parent.router.routerId;
      const foreign = yield* router.createDestination({
        projectId,
        regionId: region,
        telemetryRouterId,
        displayName,
        config: {
          configType: "OpenTelemetry",
          openTelemetry: { uri: OTLP_URI, bearerToken: "alchemy-test-token" },
        },
      });
      const error = yield* stack
        .deploy(
          app({
            displayName,
            config: {
              type: "OpenTelemetry",
              uri: OTLP_URI,
              bearerToken: Redacted.make("alchemy-test-token"),
            },
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      yield* router.deleteDestination({
        projectId,
        regionId: region,
        telemetryRouterId,
        destinationId: foreign.id,
      });
      yield* expectGone(observeDestination(projectId, region, telemetryRouterId, foreign.id));
      yield* stack.destroy();
      yield* expectGone(observeRouter(projectId, region, telemetryRouterId));
    }).pipe(logLevel),
  options,
);
