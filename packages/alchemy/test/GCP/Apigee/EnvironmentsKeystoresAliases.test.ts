import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_APIGEE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const org = `organizations/${project}`;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsEnvironmentsKeystoresAliases({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsEnvironmentsKeystoresAliases on a missing alias fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsKeystoresAliases({
          name: `${org}/environments/alchemy-missing/keystores/alchemy-missing/aliases/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a keystore alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
            environment: environment.environmentId,
          });
          const alias = yield* GCP.Apigee.EnvironmentsKeystoresAliases(
            "Server",
            {
              environment: environment.environmentId,
              keystore: keystore.keystoreId,
              subject: { commonName: "api.example.com" },
              certValidityInDays: 365,
            },
          );
          return { environment, keystore, alias };
        }),
      );

      expect(created.alias.aliasId).toEqual(expect.any(String));
      expect(created.alias.keystoreId).toEqual(created.keystore.keystoreId);
      expect(created.alias.environmentId).toEqual(
        created.environment.environmentId,
      );

      const fetched =
        yield* apigee.getOrganizationsEnvironmentsKeystoresAliases({
          name: created.alias.name,
        });
      expect(fetched.alias).toEqual(created.alias.aliasId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const keystore = yield* GCP.Apigee.EnvironmentsKeystore("Tls", {
            environment: environment.environmentId,
            keystoreId: created.keystore.keystoreId,
          });
          const alias = yield* GCP.Apigee.EnvironmentsKeystoresAliases(
            "Server",
            {
              environment: environment.environmentId,
              keystore: keystore.keystoreId,
              aliasId: created.alias.aliasId,
              subject: { commonName: "api.example.com" },
              certValidityInDays: 30,
            },
          );
          return { environment, keystore, alias };
        }),
      );

      expect(updated.alias.name).toEqual(created.alias.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.alias.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
