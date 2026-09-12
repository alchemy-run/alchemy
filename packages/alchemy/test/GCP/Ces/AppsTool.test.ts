import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ces from "@distilled.cloud/gcp/ces_v1";
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

const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_CES === "1";

const waitUntilGone = (name: string) =>
  ces.getProjectsLocationsAppsTools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAppsTools on a missing tool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsAppsTools({
          name: `projects/${project}/locations/us-central1/apps/missing/tools/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a tool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.Ces.App("Support", {
            displayName: "support",
          });
          const tool = yield* GCP.Ces.AppsTool("Lookup", {
            app: app.name,
            clientFunction: {
              name: "lookup_order",
              description: "Look up an order.",
              parameters: {
                type: "OBJECT",
                properties: { orderId: { type: "STRING" } },
              },
            },
          });
          return { app, tool };
        }),
      );

      expect(created.tool.name).toContain("/tools/");
      expect(created.tool.app).toEqual(created.app.name);
      expect(created.tool.clientFunction?.name).toEqual("lookup_order");
      expect(created.tool.clientFunction?.description).toEqual(
        "Look up an order.",
      );

      const fetched = yield* ces.getProjectsLocationsAppsTools({
        name: created.tool.name,
      });
      expect(fetched.name).toEqual(created.tool.name);
      expect(fetched.clientFunction?.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.Ces.App("Support", {
            appId: created.app.appId,
            location: created.app.location,
            displayName: "support",
          });
          const tool = yield* GCP.Ces.AppsTool("Lookup", {
            app: app.name,
            toolId: created.tool.toolId,
            clientFunction: {
              name: "lookup_order",
              description: "Look up an order by id.",
              parameters: {
                type: "OBJECT",
                properties: {
                  orderId: { type: "STRING" },
                  includeHistory: { type: "BOOLEAN" },
                },
              },
            },
          });
          return { app, tool };
        }),
      );

      expect(updated.tool.name).toEqual(created.tool.name);
      expect(updated.tool.clientFunction?.description).toEqual(
        "Look up an order by id.",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.tool.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
