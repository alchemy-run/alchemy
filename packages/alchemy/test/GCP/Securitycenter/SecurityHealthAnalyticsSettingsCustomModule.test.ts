import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";

const parent = `projects/${project}/securityHealthAnalyticsSettings`;

const alwaysTrue = {
  predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
  resourceSelector: {
    resourceTypes: ["compute.googleapis.com/Instance"],
  },
  severity: "LOW" as const,
  description: "always true",
  recommendation: "n/a",
};

const waitUntilGone = (name: string) =>
  scc.getProjectsSecurityHealthAnalyticsSettingsCustomModules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsSecurityHealthAnalyticsSettingsCustomModules on a missing module fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        scc.getProjectsSecurityHealthAnalyticsSettingsCustomModules({
          name: `${parent}/customModules/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a security health analytics custom module",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* scc
        .listProjectsSecurityHealthAnalyticsSettingsCustomModules({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securitycenter.SecurityHealthAnalyticsSettingsCustomModule(
            "AlwaysTrue",
            {
              displayName: "AlchemyAlwaysTrue",
              customConfig: alwaysTrue,
            },
          );
        }),
      );

      expect(created.moduleId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `${parent}/customModules/${created.moduleId}`,
      );
      expect(created.displayName).toEqual("AlchemyAlwaysTrue");
      expect(created.customConfig?.description).toEqual("always true");
      expect(created.enablementState).toEqual("ENABLED");

      const fetched =
        yield* scc.getProjectsSecurityHealthAnalyticsSettingsCustomModules({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.customConfig?.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securitycenter.SecurityHealthAnalyticsSettingsCustomModule(
            "AlwaysTrue",
            {
              moduleId: created.moduleId,
              displayName: "AlchemyAlwaysTrue",
              enablementState: "DISABLED",
              customConfig: {
                ...alwaysTrue,
                description: "always true disabled",
                severity: "MEDIUM",
              },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.enablementState).toEqual("DISABLED");
      expect(updated.customConfig?.description).toEqual("always true disabled");
      expect(updated.customConfig?.severity).toEqual("MEDIUM");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
