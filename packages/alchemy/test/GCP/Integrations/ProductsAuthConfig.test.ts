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
  integrations.getProjectsLocationsProductsAuthConfigs({ name }).pipe(
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

const credential = {
  credentialType: "USERNAME_AND_PASSWORD" as const,
  usernameAndPassword: { username: "alchemy", password: "test-secret" },
};

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsProductsAuthConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        integrations.getProjectsLocationsProductsAuthConfigs({
          name: `projects/${project}/locations/us-central1/products/IP/authConfigs/alchemy-missing-auth`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a product auth config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsAuthConfig("Salesforce", {
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-product-salesforce",
            description: "basic auth",
            credentialType: "USERNAME_AND_PASSWORD",
            decryptedCredential: credential,
            visibility: "PRIVATE",
          });
        }),
      );

      expect(created.name).toContain("/authConfigs/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("alchemy-product-salesforce");
      expect(created.description).toEqual("basic auth");

      const fetched =
        yield* integrations.getProjectsLocationsProductsAuthConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("basic auth");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Integrations.ProductsAuthConfig("Salesforce", {
            authConfigId: created.authConfigId,
            location: "us-central1",
            product: "IP",
            displayName: "alchemy-product-salesforce",
            description: "updated auth",
            credentialType: "USERNAME_AND_PASSWORD",
            decryptedCredential: credential,
            visibility: "PRIVATE",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated auth");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
