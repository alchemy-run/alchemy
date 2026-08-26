import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as integrations from "@distilled.cloud/gcp/integrations_v1";
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
  integrations.getProjectsLocationsProductsSfdcInstances({ name }).pipe(
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
  "getProjectsLocationsProductsSfdcInstances on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsProductsSfdcInstances({
          name: `projects/${project}/locations/us-central1/products/IP/sfdcInstances/alchemy-missing-sfdc`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a product Salesforce instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsSfdcInstance("ProdOrg", {
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-prod-org",
            description: "salesforce org",
            sfdcOrgId: "00D000000000001",
            serviceAuthority: "https://example.my.salesforce.com",
          });
        }),
      );

      expect(created.name).toContain("/sfdcInstances/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("alchemy-prod-org");
      expect(created.description).toEqual("salesforce org");
      expect(created.sfdcOrgId).toEqual("00D000000000001");

      const fetched =
        yield* integrations.getProjectsLocationsProductsSfdcInstances({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsSfdcInstance("ProdOrg", {
            sfdcInstanceId: created.sfdcInstanceId,
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-prod-org",
            description: "updated org",
            sfdcOrgId: "00D000000000001",
            serviceAuthority: "https://example.my.salesforce.com",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated org");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
