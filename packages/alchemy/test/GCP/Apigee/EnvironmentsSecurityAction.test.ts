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
  apigee.getOrganizationsEnvironmentsSecurityActions({ name }).pipe(
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
  "getOrganizationsEnvironmentsSecurityActions on a missing action fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsEnvironmentsSecurityActions({
          name: `${org}/environments/alchemy-missing/securityActions/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an environment security action",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            displayName: "runtime",
          });
          const action = yield* GCP.Apigee.EnvironmentsSecurityAction(
            "BlockProbe",
            {
              environment: environment.environmentId,
              description: "block probe",
              conditionConfig: { ipAddressRanges: ["192.0.2.1"] },
              deny: { responseCode: 403 },
            },
          );
          return { environment, action };
        }),
      );

      expect(created.action.securityActionId).toEqual(expect.any(String));
      expect(created.action.description).toEqual("block probe");
      expect(created.action.deny?.responseCode).toEqual(403);

      const fetched = yield* apigee.getOrganizationsEnvironmentsSecurityActions(
        {
          name: created.action.name,
        },
      );
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("block probe");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const environment = yield* GCP.Apigee.Environment("Runtime", {
            environmentId: created.environment.environmentId,
            displayName: "runtime",
          });
          const action = yield* GCP.Apigee.EnvironmentsSecurityAction(
            "BlockProbe",
            {
              environment: environment.environmentId,
              securityActionId: created.action.securityActionId,
              description: "block probe updated",
              conditionConfig: { ipAddressRanges: ["192.0.2.1"] },
              deny: { responseCode: 403 },
            },
          );
          return { environment, action };
        }),
      );

      expect(updated.action.name).toEqual(created.action.name);
      expect(updated.action.description).toEqual("block probe updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.action.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
