import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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
  scc
    .getOrganizationsSecurityHealthAnalyticsSettingsCustomModules({ name })
    .pipe(
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

const organizationOf = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
    }
    return "";
  });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsSecurityHealthAnalyticsSettingsCustomModules on a missing module fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        scc.getOrganizationsSecurityHealthAnalyticsSettingsCustomModules({
          name: `${organization}/securityHealthAnalyticsSettings/customModules/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete an organization security health analytics custom module",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          scc.createOrganizationsSecurityHealthAnalyticsSettingsCustomModules({
            parent: "organizations/0/securityHealthAnalyticsSettings",
            body: {
              displayName: "AlchemyProbe",
              enablementState: "ENABLED",
              customConfig: alwaysTrue,
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const parent = `${organization}/securityHealthAnalyticsSettings`;
      const access = yield* scc
        .listOrganizationsSecurityHealthAnalyticsSettingsCustomModules({
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
          return yield* GCP.Securitycenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule(
            "AlwaysTrue",
            {
              organization,
              displayName: "AlchemyOrgAlwaysTrue",
              customConfig: alwaysTrue,
            },
          );
        }),
      );

      expect(created.moduleId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${parent}/customModules/${created.moduleId}`,
      );
      expect(created.displayName).toEqual("AlchemyOrgAlwaysTrue");
      expect(created.customConfig?.description).toEqual("always true");

      const fetched =
        yield* scc.getOrganizationsSecurityHealthAnalyticsSettingsCustomModules(
          {
            name: created.name,
          },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.customConfig?.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securitycenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule(
            "AlwaysTrue",
            {
              organization,
              moduleId: created.moduleId,
              displayName: "AlchemyOrgAlwaysTrue",
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

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
