import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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

const waitUntilGone = (name: string) =>
  networksecurity.getOrganizationsLocationsAddressGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsLocationsAddressGroups on a missing group fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const parent = resource.parent ?? "organizations/0";
      const organization = parent.startsWith("organizations/")
        ? parent.slice("organizations/".length)
        : "0";
      const error = yield* Effect.flip(
        networksecurity.getOrganizationsLocationsAddressGroups({
          name: `organizations/${organization}/locations/global/addressGroups/alchemy-missing-address-group`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.GCP_TEST_ORG_NETWORKSECURITY,
)(
  "createOrganizationsLocationsAddressGroups without org IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const parent = resource.parent ?? "organizations/0";
      const organization = parent.startsWith("organizations/")
        ? parent.slice("organizations/".length)
        : parent.startsWith("folders/")
          ? "0"
          : parent;
      const error = yield* Effect.flip(
        networksecurity.createOrganizationsLocationsAddressGroups({
          parent: `organizations/${organization}/locations/global`,
          addressGroupId: "alchemy-org-address-group-probe",
          body: {
            type: "IPV4",
            capacity: 100,
            items: ["10.0.0.1"],
          },
        }),
      );
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds ||
    !!process.env.FAST ||
    !process.env.GCP_TEST_ORG_NETWORKSECURITY,
)(
  "create, update, and delete an organization address group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Networksecurity.OrganizationsAddressGroup(
            "OrgAllowlist",
            {
              type: "IPV4",
              capacity: 100,
              items: ["10.0.0.1"],
              description: "org address group a",
              labels: { env: "test" },
            },
          );
        }),
      );

      expect(created.name).toContain("/addressGroups/");
      expect(created.name).toContain("organizations/");
      expect(created.addressGroupId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.items).toEqual(["10.0.0.1"]);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networksecurity.getOrganizationsLocationsAddressGroups({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Networksecurity.OrganizationsAddressGroup(
            "OrgAllowlist",
            {
              addressGroupId: created.addressGroupId,
              organization: created.organization,
              type: "IPV4",
              capacity: 100,
              items: ["10.0.0.1", "10.1.0.0/24"],
              description: "org address group b",
              labels: { env: "prod", role: "allowlist" },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("org address group b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "allowlist" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
