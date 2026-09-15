import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cnr from "@distilled.cloud/gcp/cloudnumberregistry_v1alpha";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  location,
  logLevel,
  probeIpamAdminScopes,
  project,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const organizationScope = () => {
  const fromEnv = process.env.GCP_CNR_ORG;
  if (fromEnv && fromEnv.length > 0) {
    return Effect.succeed(
      fromEnv.includes("/") ? fromEnv : `organizations/${fromEnv}`,
    );
  }
  return resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((item) =>
      item.parent?.startsWith("organizations/") ? item.parent : undefined,
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(undefined)),
  );
};

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsIpamAdminScopes on a missing scope fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cnr.getProjectsLocationsIpamAdminScopes({
          name: `projects/${project}/locations/${location}/ipamAdminScopes/alchemy-missing-scope`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an ipam admin scope",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeIpamAdminScopes();
      if (probe.tag !== "ok") {
        expect([...entitlementTags]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const org = yield* organizationScope();
      if (org === undefined) {
        const availability = yield* cnr
          .checkAvailabilityProjectsLocationsIpamAdminScopes({
            parent: `projects/${project}/locations/${location}`,
            scopes: ["organizations/1"],
          })
          .pipe(
            Effect.as("ok" as const),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed("Forbidden" as const),
            ),
            Effect.catchTag("NotFound", () =>
              Effect.succeed("NotFound" as const),
            ),
          );
        expect([...entitlementTags, "ok"]).toContain(availability);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Cloudnumberregistry.IpamAdminScope("Org", {
            location,
            scopes: [org],
            enabledAddonPlatforms: ["COMPUTE_ENGINE"],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.ipamAdminScopeId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/${location}/ipamAdminScopes/${created.ipamAdminScopeId}`,
      );
      expect(created.scopes).toContain(org);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* cnr.getProjectsLocationsIpamAdminScopes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Cloudnumberregistry.IpamAdminScope("Org", {
            ipamAdminScopeId: created.ipamAdminScopeId,
            location,
            scopes: [org],
            enabledAddonPlatforms: ["COMPUTE_ENGINE"],
            labels: { env: "prod", role: "ipam" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.ipamAdminScopeId).toEqual(created.ipamAdminScopeId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "ipam" });

      const refetched = yield* cnr.getProjectsLocationsIpamAdminScopes({
        name: created.name,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("ipam");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        cnr.getProjectsLocationsIpamAdminScopes({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
