import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsDashboardsCharts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDashboardsCharts on a missing chart fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsDashboardsCharts({
          name: `projects/${project}/locations/us-central1/dashboards/missing/charts/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.FAST || !process.env.GCP_TEST_CCI_DASHBOARDS,
)(
  "create, update, and delete a dashboard chart",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const dashboard = yield* GCP.Contactcenterinsights.Dashboard(
            "Board",
            {
              location: "us-central1",
              displayName: "chart-board",
            },
          );
          return yield* GCP.Contactcenterinsights.DashboardsChart("Volume", {
            parent: dashboard.name,
            displayName: "volume",
            description: "call volume",
            chartVisualizationType: "BAR",
            width: 2,
            height: 2,
          });
        }),
      );

      expect(created.name).toContain("/charts/");
      expect(created.displayName).toEqual("volume");
      expect(created.description).toEqual("call volume");

      const fetched = yield* cci.getProjectsLocationsDashboardsCharts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const dashboard = yield* GCP.Contactcenterinsights.Dashboard(
            "Board",
            {
              location: "us-central1",
              displayName: "chart-board",
            },
          );
          return yield* GCP.Contactcenterinsights.DashboardsChart("Volume", {
            parent: dashboard.name,
            chartId: created.chartId,
            displayName: "volume-v2",
            description: "updated volume",
            chartVisualizationType: "LINE",
            width: 3,
            height: 2,
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("volume-v2");
      expect(updated.description).toEqual("updated volume");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
