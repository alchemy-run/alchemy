import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apigateway from "@distilled.cloud/gcp/apigateway_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (name: string) =>
  apigateway.getProjectsLocationsApis({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an API Gateway API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        GCP.ApiGateway.Api("Orders", { displayName: "orders", labels: { env: "test" } }),
      );
      expect(created.apiId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${created.project}/locations/global/apis/${created.apiId}`,
      );
      expect(created.state).toEqual("ACTIVE");
      expect(created.managedService).toContain(".apigateway.");

      const fetched = yield* apigateway.getProjectsLocationsApis({ name: created.name });
      expect(fetched.displayName).toEqual("orders");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        GCP.ApiGateway.Api("Orders", {
          displayName: "orders-prod",
          labels: { env: "prod", team: "edge" },
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.managedService).toEqual(created.managedService);
      expect(updated.labels).toEqual({ env: "prod", team: "edge" });

      const refetched = yield* apigateway.getProjectsLocationsApis({ name: created.name });
      expect(refetched.displayName).toEqual("orders-prod");
      expect(refetched.labels?.team).toEqual("edge");

      // an unchanged redeploy plans no update
      const plan = yield* stack.plan(
        GCP.ApiGateway.Api("Orders", {
          displayName: "orders-prod",
          labels: { env: "prod", team: "edge" },
        }),
      );
      expect(plan.resources.Orders.action).toBe("noop");

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.name)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigateway", "live"], timeout: 600_000 },
);
